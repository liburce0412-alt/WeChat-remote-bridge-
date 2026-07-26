import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type RealtimeFailure,
  RealtimeManager,
  type RealtimeUtterance,
  speechOutputTimeoutMs,
  toSpeakableText,
} from "./codex/realtime.js";
import { Logger } from "./logger.js";
import { dataDirectory } from "./paths.js";
import { StateStore } from "./state.js";
import type { BridgeState, OutboxEntry, SpeechOutboxEntry } from "./types.js";
import { WeixinClient } from "./weixin/client.js";
import { pcm16ToWav } from "./weixin/media.js";

export const VOICE_ATTACHMENT_NAME = "迟迟的语音.wav";

export class DeliveryQueue {
  private flushing?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly getState: () => BridgeState,
    private readonly getWeixin: () => WeixinClient,
    private readonly store: StateStore,
    private readonly realtime: RealtimeManager,
    private readonly logger: Logger,
    private readonly suppressSpeech: (threadId: string) => void,
  ) {}

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  async queueText(to: string, text: string, contextToken?: string): Promise<void> {
    this.enqueueText(to, text, contextToken);
    await this.store.save(this.getState());
    await this.flush();
  }

  enqueueText(to: string, text: string, contextToken?: string): void {
    this.getState().outbox.push({
      id: crypto.randomUUID(),
      kind: "text",
      to,
      text,
      contextToken,
      createdAt: Date.now(),
      attempts: 0,
    });
  }

  enqueueFile(
    to: string,
    filePath: string,
    name: string,
    mediaKind: "file" | "audio",
    contextToken?: string,
    managed = false,
  ): void {
    this.getState().outbox.push({
      id: crypto.randomUUID(),
      kind: "file",
      to,
      path: filePath,
      name,
      mediaKind,
      managed,
      contextToken,
      createdAt: Date.now(),
      attempts: 0,
    });
  }

  enqueueSpeech(to: string, threadId: string, text: string, contextToken?: string): void {
    this.getState().outbox.push({
      id: crypto.randomUUID(),
      kind: "speech",
      to,
      threadId,
      text: toSpeakableText(text),
      fallbackText: text,
      name: VOICE_ATTACHMENT_NAME,
      contextToken,
      createdAt: Date.now(),
      attempts: 0,
    });
  }

  async flush(): Promise<void> {
    if (this.flushing) return await this.flushing;
    this.flushing = this.flushExclusive();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushExclusive(): Promise<void> {
    const state = this.getState();
    while (!this.stopped && state.outbox.length > 0) {
      const item = state.outbox[0]!;
      if (item.nextAttemptAt && item.nextAttemptAt > Date.now()) {
        this.scheduleRetry(item.nextAttemptAt - Date.now());
        break;
      }
      try {
        if (item.kind === "speech") {
          await this.renderSpeech(item);
          continue;
        }
        if (item.kind === "text") {
          await this.getWeixin().sendText(item.to, item.text, item.contextToken, item.id);
        } else {
          if (!fs.existsSync(item.path)) {
            state.outbox[0] = this.missingFileFallback(item);
            await this.store.save(state);
            continue;
          }
          if (item.mediaKind === "audio") {
            await this.getWeixin().sendAudioFile(
              item.to,
              fs.readFileSync(item.path),
              item.name,
              item.contextToken,
              item.id,
            );
          } else {
            await this.getWeixin().sendMediaFile(item.to, item.path, item.contextToken, item.id);
          }
        }
        state.outbox.shift();
        if (item.kind === "file" && item.managed) fs.rmSync(item.path, { force: true });
      } catch (error) {
        if (item.kind === "speech") {
          this.suppressSpeech(item.threadId);
          this.logger.warn(`GPT-Live 结果朗读失败，已改发文字: ${String(error)}`);
          const reason = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
          state.outbox[0] = {
            id: item.id,
            kind: "text",
            to: item.to,
            text: `GPT-Live 语音朗读失败：${reason}\n以下为文字结果：\n${item.fallbackText}`,
            contextToken: item.contextToken,
            createdAt: item.createdAt,
            attempts: 0,
          };
          await this.store.save(state);
          continue;
        }
        item.attempts += 1;
        item.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        item.nextAttemptAt = Date.now() + retryDelayMs(item.attempts);
        await this.store.save(state);
        this.logger.warn(`微信回复发送失败，已保留并将在后台重试（第 ${item.attempts} 次）`);
        this.scheduleRetry(item.nextAttemptAt - Date.now());
        break;
      }
      await this.store.save(state);
    }
  }

  private async renderSpeech(item: SpeechOutboxEntry): Promise<void> {
    const { promise, cancel } = this.waitForUtterance(
      item.threadId,
      speechOutputTimeoutMs(item.text) + 5_000,
    );
    try {
      await this.realtime.speak(item.threadId, item.text);
      const utterance = await promise;
      const durationMs = Math.round(
        utterance.pcm.length * 1_000 / (utterance.sampleRate * utterance.numChannels * 2),
      );
      this.logger.info(`GPT-Live 已生成 ${durationMs}ms 语音，已写入可靠投递队列`);
      const directory = path.join(dataDirectory(), "media", "outbound");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${item.id}.wav`);
      fs.writeFileSync(
        file,
        pcm16ToWav(utterance.pcm, utterance.sampleRate, utterance.numChannels),
        { mode: 0o600 },
      );
      this.getState().outbox[0] = {
        id: item.id,
        kind: "file",
        to: item.to,
        path: file,
        name: item.name,
        mediaKind: "audio",
        managed: true,
        contextToken: item.contextToken,
        createdAt: item.createdAt,
        attempts: item.attempts,
      };
      await this.store.save(this.getState());
    } finally {
      cancel();
    }
  }

  private waitForUtterance(
    threadId: string,
    timeoutMs: number,
  ): { promise: Promise<RealtimeUtterance>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let resolvePromise!: (utterance: RealtimeUtterance) => void;
    let rejectPromise!: (error: Error) => void;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      this.realtime.off("utterance", onUtterance);
      this.realtime.off("failure", onFailure);
    };
    const onUtterance = (utterance: RealtimeUtterance) => {
      if (utterance.threadId !== threadId || settled) return;
      settled = true;
      cleanup();
      resolvePromise(utterance);
    };
    const onFailure = (failure: RealtimeFailure) => {
      if (failure.threadId !== threadId || settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(failure.message));
    };
    const promise = new Promise<RealtimeUtterance>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    void promise.catch(() => undefined);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error(`等待 GPT-Live 音频超过 ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    this.realtime.on("utterance", onUtterance);
    this.realtime.on("failure", onFailure);
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
      },
    };
  }

  private missingFileFallback(item: Extract<OutboxEntry, { kind: "file" }>): OutboxEntry {
    return {
      id: item.id,
      kind: "text",
      to: item.to,
      text: `待发送文件已经不存在：${item.name}`,
      contextToken: item.contextToken,
      createdAt: item.createdAt,
      attempts: 0,
    };
  }

  private scheduleRetry(delayMs: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush().catch((error) => {
        this.logger.warn(`微信 outbox 后台重试失败: ${String(error)}`);
      });
    }, Math.max(250, delayMs));
    this.retryTimer.unref();
  }
}

export function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 2_000 * (2 ** Math.min(Math.max(0, attempts - 1), 8)));
}
