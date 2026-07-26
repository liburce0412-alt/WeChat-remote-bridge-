import { EventEmitter } from "node:events";
import type { Logger } from "../logger.js";
import type { CodexNotification, RealtimeAudioChunk, RealtimeStartOptions } from "./client.js";
import { WebRtcAudioPeer, type WebRtcAudioFrame } from "./webrtc-peer.js";

const INPUT_SAMPLE_RATE = 24_000;
const INPUT_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const INPUT_CHUNK_MS = 20;
const INPUT_CHUNK_BYTES = INPUT_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * INPUT_CHUNK_MS / 1_000;
const VAD_TAIL_MS = 500;
const APPEND_BATCH_SIZE = 4;
const WEBRTC_INPUT_SETTLE_MS = 1_000;
const MIN_SPEECH_OUTPUT_TIMEOUT_MS = 30_000;
const MAX_SPEECH_OUTPUT_TIMEOUT_MS = 120_000;
const MAX_SPEAKABLE_TEXT_LENGTH = 1_200;
const INPUT_REQUEST_TIMEOUT_MS = 12_000;
const MAX_INPUT_AUDIO_MS = 120_000;
const INPUT_SEND_GRACE_MS = 5_000;
const OUTPUT_AUDIBLE_PEAK = 48;
const MIN_OUTPUT_AUDIO_MS = 100;
export const SPEECH_RENDERER_PROMPT = [
  "You are a speech renderer.",
  "Speak the provided text verbatim in its original language.",
  "Never translate, paraphrase, answer, or add words.",
  "When the text is Chinese, speak Mandarin Chinese.",
].join(" ");

export interface RealtimeTransport {
  on(event: "notification", listener: (notification: CodexNotification) => void): unknown;
  off(event: "notification", listener: (notification: CodexNotification) => void): unknown;
  startRealtime(threadId: string, options: RealtimeStartOptions, timeoutMs?: number): Promise<void>;
  appendRealtimeText(threadId: string, text: string): Promise<void>;
  appendRealtimeAudio(threadId: string, audio: RealtimeAudioChunk): Promise<void>;
  appendRealtimeSpeech(threadId: string, text: string): Promise<void>;
  stopRealtime(threadId: string, timeoutMs?: number): Promise<void>;
}

export interface RealtimeManagerOptions {
  model: string;
  voice: string;
  transport: "websocket" | "webrtc";
  idleMs: number;
  startTimeoutMs: number;
  audioQuietMs: number;
  outputTimeoutMs: number;
}

export interface RealtimeUtterance {
  threadId: string;
  pcm: Buffer;
  sampleRate: number;
  numChannels: number;
  transcript?: string;
}

export interface RealtimeFailure {
  threadId: string;
  message: string;
  transcript?: string;
}

export interface RealtimeStatus {
  active: boolean;
  connecting: boolean;
  threadId?: string;
  taskActive: boolean;
  lastActivityAt?: number;
  model: string;
  voice: string;
  transport: "websocket" | "webrtc";
  clientManagedHandoffs: boolean;
  version: "v1" | "v3";
}

interface StartAttempt {
  threadId: string;
  requireSdp: boolean;
  started: boolean;
  sdpAccepted: boolean;
  sdpPending: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RealtimeDeliveryError extends Error {
  constructor(
    message: string,
    readonly inputAccepted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RealtimeDeliveryError";
  }
}

export function realtimeOptionsFromEnv(): RealtimeManagerOptions {
  return {
    model: process.env.WEIXIN_CODEX_REALTIME_MODEL?.trim() || "gpt-live-1-codex",
    voice: process.env.WEIXIN_CODEX_REALTIME_VOICE?.trim().toLowerCase() || "sol",
    transport: "webrtc",
    idleMs: positiveInteger(process.env.WEIXIN_CODEX_REALTIME_IDLE_MS, 300_000),
    startTimeoutMs: 15_000,
    audioQuietMs: 900,
    outputTimeoutMs: positiveInteger(process.env.WEIXIN_CODEX_REALTIME_OUTPUT_TIMEOUT_MS, 30_000),
  };
}

export class RealtimeManager extends EventEmitter {
  private threadId?: string;
  private connecting = false;
  private active = false;
  private taskActive = false;
  private clientManagedHandoffs = false;
  private sessionVersion: "v1" | "v3" = "v3";
  private preferredVersion: "v1" | "v3" = "v3";
  private inputReadyAt?: number;
  private lastActivityAt?: number;
  private startPromise?: Promise<void>;
  private startAttempt?: StartAttempt;
  private peer?: WebRtcAudioPeer;
  private generation = 0;
  private idleTimer?: NodeJS.Timeout;
  private audioTimer?: NodeJS.Timeout;
  private outputTimer?: NodeJS.Timeout;
  private audioChunks: Buffer[] = [];
  private audioSampleRate = INPUT_SAMPLE_RATE;
  private audioChannels = INPUT_CHANNELS;
  private audioItemId?: string;
  private assistantTranscript = "";
  private awaitingOutput = false;
  private outputStarted = false;
  private pendingInputKind?: "task" | "speech";
  private outputSequence = 0;
  private intentionalStop = false;
  private readonly onNotificationBound = (event: CodexNotification) => this.onNotification(event);

  constructor(
    private readonly transport: RealtimeTransport,
    private readonly logger: Logger,
    private readonly options: RealtimeManagerOptions = realtimeOptionsFromEnv(),
  ) {
    super();
    this.transport.on("notification", this.onNotificationBound);
  }

  getStatus(): RealtimeStatus {
    return {
      active: this.active,
      connecting: this.connecting,
      threadId: this.threadId,
      taskActive: this.taskActive,
      lastActivityAt: this.lastActivityAt,
      model: this.options.model,
      voice: this.options.voice,
      transport: this.options.transport,
      clientManagedHandoffs: this.clientManagedHandoffs,
      version: this.active || this.connecting ? this.sessionVersion : this.preferredVersion,
    };
  }

  async start(threadId: string, clientManagedHandoffs = false): Promise<void> {
    await this.ensureStarted(threadId, clientManagedHandoffs, this.preferredVersion);
  }

  async sendText(threadId: string, text: string): Promise<void> {
    await this.ensureStarted(threadId, false, this.preferredVersion);
    await this.waitUntilInputReady(threadId);
    this.touch();
    this.awaitingOutput = true;
    this.outputStarted = false;
    this.pendingInputKind = "task";
    const generation = this.generation;
    const outputSequence = this.outputSequence;
    try {
      const append = this.transport.appendRealtimeText(threadId, text);
      const acceptedOrAnswered = this.options.transport === "webrtc"
        ? Promise.race([
            append,
            this.waitForOutputAfter(threadId, generation, outputSequence),
          ])
        : append;
      await withTimeout(
        acceptedOrAnswered,
        INPUT_REQUEST_TIMEOUT_MS,
        `GPT-Live 文字输入在 ${INPUT_REQUEST_TIMEOUT_MS}ms 内没有提交完成`,
      );
      this.armOutputTimeout(threadId, this.generation);
    } catch (cause) {
      await this.stop("text-input-failed");
      if (this.outputSequence > outputSequence) return;
      throw new RealtimeDeliveryError(`GPT-Live 已连接，但文字输入提交失败：${errorMessage(cause)}`, true, { cause });
    }
  }

  async sendPcm(threadId: string, pcm: Buffer): Promise<void> {
    if (!pcm.length || pcm.length % PCM_BYTES_PER_SAMPLE !== 0) {
      throw new RealtimeDeliveryError("微信语音解码后没有有效的 PCM16 音频", false);
    }
    const inputDurationMs = pcm.length * 1_000 / (INPUT_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
    if (inputDurationMs > MAX_INPUT_AUDIO_MS) {
      throw new RealtimeDeliveryError(
        `微信语音解码后长达 ${Math.ceil(inputDurationMs / 1_000)} 秒，超过 ${MAX_INPUT_AUDIO_MS / 1_000} 秒限制`,
        false,
      );
    }
    await this.ensureStarted(threadId, false, this.preferredVersion);
    await this.waitUntilInputReady(threadId);
    this.touch();
    const generation = this.generation;
    this.awaitingOutput = true;
    this.outputStarted = false;
    this.pendingInputKind = "task";
    const withVadTail = Buffer.concat([
      pcm,
      Buffer.alloc(INPUT_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * VAD_TAIL_MS / 1_000),
    ]);
    try {
      if (this.options.transport === "webrtc") {
        const peer = this.peer;
        if (!peer) {
          throw new RealtimeDeliveryError("GPT-Live WebRTC 音频轨道尚未建立", false);
        }
        const sendTimeoutMs = Math.ceil(inputDurationMs + VAD_TAIL_MS + INPUT_SEND_GRACE_MS);
        await withTimeout(
          peer.sendPcm24k(withVadTail),
          sendTimeoutMs,
          `WebRTC 语音输入在 ${sendTimeoutMs}ms 内没有提交完成`,
        );
        if (generation !== this.generation || !this.active || this.threadId !== threadId) {
          throw new Error("GPT-Live 会话在语音输入期间已关闭");
        }
        this.armOutputTimeout(threadId, generation);
        return;
      }
      for (let offset = 0; offset < withVadTail.length; offset += INPUT_CHUNK_BYTES * APPEND_BATCH_SIZE) {
        if (
          generation !== this.generation
          || !this.active
          || this.threadId !== threadId
          || this.outputStarted
        ) break;
        const requests: Promise<void>[] = [];
        const batchEnd = Math.min(withVadTail.length, offset + INPUT_CHUNK_BYTES * APPEND_BATCH_SIZE);
        for (let chunkOffset = offset; chunkOffset < batchEnd; chunkOffset += INPUT_CHUNK_BYTES) {
          const chunk = withVadTail.subarray(chunkOffset, Math.min(batchEnd, chunkOffset + INPUT_CHUNK_BYTES));
          requests.push(this.transport.appendRealtimeAudio(threadId, {
            data: chunk.toString("base64"),
            sampleRate: INPUT_SAMPLE_RATE,
            numChannels: INPUT_CHANNELS,
            samplesPerChannel: chunk.length / PCM_BYTES_PER_SAMPLE,
            itemId: null,
          }));
        }
        await Promise.all(requests);
      }
      if (generation !== this.generation || !this.active || this.threadId !== threadId) {
        throw new Error("GPT-Live 会话在语音输入期间已关闭");
      }
      this.armOutputTimeout(threadId, generation);
    } catch (cause) {
      await this.stop("audio-input-failed");
      throw new RealtimeDeliveryError(`GPT-Live 已连接，但语音输入提交失败：${errorMessage(cause)}`, true, { cause });
    }
  }

  async speak(threadId: string, text: string): Promise<void> {
    const speakable = toSpeakableText(text);
    if (!speakable) throw new RealtimeDeliveryError("Codex 结果中没有可朗读的文字", false);
    const timeoutMs = speechOutputTimeoutMs(speakable);
    let firstError: unknown;
    const firstVersion = this.active
      && this.threadId === threadId
      && this.clientManagedHandoffs
      ? this.sessionVersion
      : "v3";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = attempt === 0 ? firstVersion : "v3";
      try {
        await this.ensureStarted(threadId, true, version);
        await this.waitUntilInputReady(threadId);
        this.touch();
        const generation = this.generation;
        const outputSequence = this.outputSequence;
        this.awaitingOutput = true;
        this.outputStarted = false;
        this.pendingInputKind = "speech";
        const output = this.options.transport === "webrtc"
          ? this.waitForOutputAfter(threadId, generation, outputSequence, timeoutMs)
          : undefined;
        const append = this.transport.appendRealtimeSpeech(threadId, speakable);
        const acceptedOrAnswered = output
          ? Promise.race([append, output])
          : append;
        await withTimeout(
          acceptedOrAnswered,
          timeoutMs,
          `${timeoutMs}ms 内没有收到 GPT-Live 朗读音频`,
        );
        if (output) {
          await output;
        }
        return;
      } catch (cause) {
        firstError ??= cause;
        if (attempt === 0) {
          this.logger.warn(`GPT-Live 朗读未返回音频，正在安全重连一次: ${errorMessage(cause)}`);
          await this.stop("speech-output-retry");
          continue;
        }
        throw new RealtimeDeliveryError(
          `GPT-Live 朗读请求失败：${errorMessage(firstError)}`,
          true,
          { cause: firstError },
        );
      }
    }
  }

  async stop(reason = "requested"): Promise<void> {
    const threadId = this.threadId;
    this.generation += 1;
    this.intentionalStop = true;
    this.clearTimers();
    this.flushAudio();
    this.resetSession();
    if (!threadId) return;
    this.logger.debug(`正在释放 GPT-Live 会话 ${threadId} (${reason})`);
    await this.transport.stopRealtime(threadId).catch((error) => {
      this.logger.warn(`GPT-Live 会话释放失败: ${errorMessage(error)}`);
    });
  }

  async dispose(): Promise<void> {
    await this.stop("bridge-stop");
    this.transport.off("notification", this.onNotificationBound);
    this.removeAllListeners();
  }

  private async ensureStarted(
    threadId: string,
    clientManagedHandoffs: boolean,
    version: "v1" | "v3",
  ): Promise<void> {
    if (
      (this.active || this.startPromise)
      && this.threadId === threadId
      && (
        this.clientManagedHandoffs !== clientManagedHandoffs
        || this.sessionVersion !== version
      )
    ) {
      await this.stop("handoff-mode-switch");
    }
    if (
      this.active
      && this.threadId === threadId
      && this.clientManagedHandoffs === clientManagedHandoffs
      && this.sessionVersion === version
    ) {
      this.touch();
      return;
    }
    if (
      this.startPromise
      && this.threadId === threadId
      && this.clientManagedHandoffs === clientManagedHandoffs
      && this.sessionVersion === version
    ) return await this.startPromise;
    if (this.threadId && this.threadId !== threadId) await this.stop("thread-switch");

    const generation = ++this.generation;
    this.threadId = threadId;
    this.clientManagedHandoffs = clientManagedHandoffs;
    this.sessionVersion = version;
    this.connecting = true;
    this.active = false;
    this.taskActive = false;
    this.intentionalStop = false;
    this.startPromise = this.startWithRetry(
      threadId,
      generation,
      clientManagedHandoffs,
      version,
    );
    try {
      await this.startPromise;
    } finally {
      if (this.generation === generation) this.startPromise = undefined;
    }
  }

  private async startWithRetry(
    threadId: string,
    generation: number,
    clientManagedHandoffs: boolean,
    version: "v1" | "v3",
  ): Promise<void> {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const useConfiguredModel = attempt === 0 && version === "v3";
      let peer: WebRtcAudioPeer | undefined;
      try {
        let realtimeTransport: RealtimeStartOptions["transport"];
        if (this.options.transport === "webrtc") {
          peer = this.createWebRtcPeer(threadId);
          this.peer = peer;
          realtimeTransport = { type: "webrtc", sdp: await peer.createOffer() };
        }
        const started = this.beginStartAttempt(threadId, this.options.transport === "webrtc");
        await Promise.all([
          this.transport.startRealtime(threadId, {
            ...(useConfiguredModel ? { model: this.options.model } : {}),
            voice: this.options.voice,
            ...(clientManagedHandoffs ? { prompt: SPEECH_RENDERER_PROMPT } : {}),
            version,
            clientManagedHandoffs,
            ...(realtimeTransport ? { transport: realtimeTransport } : {}),
          }, this.options.startTimeoutMs),
          started,
        ]);
        if (generation !== this.generation || this.threadId !== threadId) {
          await this.transport.stopRealtime(threadId).catch(() => undefined);
          throw new RealtimeDeliveryError("GPT-Live 会话在建连期间已被取消", false);
        }
        this.connecting = false;
        this.active = true;
        this.inputReadyAt = Date.now() + (
          this.options.transport === "webrtc" ? WEBRTC_INPUT_SETTLE_MS : 0
        );
        this.touch();
        const modelLabel = useConfiguredModel
          ? this.options.model
          : version === "v1"
            ? "Codex V1 默认模型"
            : "Codex 默认模型";
        this.logger.info(`GPT-Live 已连接：${threadId}（${modelLabel} / ${this.options.voice} / ${version}）`);
        return;
      } catch (error) {
        this.rejectStartAttempt(error instanceof Error ? error : new Error(String(error)));
        if (error instanceof RealtimeDeliveryError) throw error;
        firstError ??= error;
        this.logger.warn(`GPT-Live 第 ${attempt + 1} 次建连失败: ${errorMessage(error)}`);
        if (this.peer === peer) this.peer = undefined;
        peer?.close();
        this.threadId = threadId;
        this.connecting = true;
        this.active = false;
        await this.transport.stopRealtime(threadId, 3_000).catch(() => undefined);
        this.threadId = threadId;
        if (attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    if (generation === this.generation) {
      this.clearTimers();
      this.resetSession();
    }
    throw new RealtimeDeliveryError(
      `GPT-Live 建连失败，已尝试配置模型和 Codex 默认模型：${errorMessage(firstError)}`,
      false,
      { cause: firstError },
    );
  }

  private onNotification(event: CodexNotification): void {
    const params = event.params ?? {};
    const eventThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!eventThreadId || eventThreadId !== this.threadId) return;

    if (event.method === "thread/realtime/started") {
      if (this.startAttempt) {
        this.startAttempt.started = true;
        this.completeStartAttempt();
      } else {
        this.connecting = false;
        this.active = true;
        this.touch();
      }
      return;
    }
    if (event.method === "thread/realtime/sdp") {
      const sdp = typeof params.sdp === "string" ? params.sdp : undefined;
      const attempt = this.startAttempt;
      const peer = this.peer;
      if (!sdp || !attempt || !peer) return;
      if (attempt.sdpAccepted || attempt.sdpPending) return;
      attempt.sdpPending = true;
      void peer.acceptAnswer(sdp).then(() => {
        if (this.startAttempt !== attempt) return;
        attempt.sdpAccepted = true;
        this.completeStartAttempt();
      }).catch((error) => this.rejectStartAttempt(
        new Error(`WebRTC 远端 SDP 设置失败：${errorMessage(error)}`),
      ));
      return;
    }
    if (event.method === "thread/realtime/outputAudio/delta") {
      this.handleAudio(eventThreadId, params.audio);
      return;
    }
    if (event.method === "thread/realtime/transcript/delta") {
      if (params.role === "assistant" && typeof params.delta === "string") {
        this.assistantTranscript += params.delta;
      }
      this.touch();
      return;
    }
    if (event.method === "thread/realtime/transcript/done") {
      if (params.role === "assistant" && typeof params.text === "string") {
        this.assistantTranscript = params.text;
        this.scheduleAudioFlush();
      }
      this.touch();
      return;
    }
    if (event.method === "thread/status/changed") {
      const status = params.status as { type?: unknown } | undefined;
      this.taskActive = status?.type === "active";
      this.touch();
      return;
    }
    if (event.method === "turn/started") {
      this.taskActive = true;
      this.touch();
      return;
    }
    if (event.method === "turn/completed") {
      this.taskActive = false;
      this.touch();
      return;
    }
    if (event.method === "thread/realtime/error") {
      const message = typeof params.message === "string" ? params.message : "GPT-Live 会话发生未知错误";
      if (this.startAttempt) {
        this.rejectStartAttempt(new Error(message));
        return;
      }
      const awaitingOutput = this.awaitingOutput;
      const pendingInputKind = this.pendingInputKind;
      const transcript = this.assistantTranscript.trim() || undefined;
      const outputCompleted = this.flushAudio(false);
      this.clearTimers();
      this.resetSession();
      if (awaitingOutput && !outputCompleted && pendingInputKind === "task") {
        this.emitFailure(eventThreadId, message, transcript);
      } else {
        this.emit("closed", { threadId: eventThreadId, reason: message, intentional: false });
      }
      return;
    }
    if (event.method === "thread/realtime/closed") {
      if (this.startAttempt) {
        if (params.reason === "requested") {
          this.logger.debug("忽略上一轮 GPT-Live 主动清理产生的迟到关闭通知");
          return;
        }
        this.rejectStartAttempt(new Error(
          typeof params.reason === "string" ? params.reason : "GPT-Live 在建连期间关闭",
        ));
        return;
      }
      if (this.connecting) return;
      const intentional = this.intentionalStop;
      const awaitingOutput = this.awaitingOutput;
      const pendingInputKind = this.pendingInputKind;
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      const outputCompleted = this.flushAudio(false);
      this.clearTimers();
      this.resetSession();
      if (
        !intentional
        && awaitingOutput
        && !outputCompleted
        && pendingInputKind === "task"
      ) {
        this.emitFailure(eventThreadId, reason || "GPT-Live 会话意外关闭");
      } else {
        this.emit("closed", { threadId: eventThreadId, reason, intentional });
      }
      return;
    }
    if (event.method.startsWith("thread/realtime/")) this.touch();
  }

  private handleAudio(threadId: string, value: unknown): void {
    const audio = value as Partial<RealtimeAudioChunk> | undefined;
    if (!audio || typeof audio.data !== "string") return;
    const sampleRate = typeof audio.sampleRate === "number" ? audio.sampleRate : INPUT_SAMPLE_RATE;
    const channels = typeof audio.numChannels === "number" ? audio.numChannels : INPUT_CHANNELS;
    const itemId = typeof audio.itemId === "string" ? audio.itemId : undefined;
    if (
      this.audioChunks.length
      && (
        sampleRate !== this.audioSampleRate
        || channels !== this.audioChannels
        || (itemId && this.audioItemId && itemId !== this.audioItemId)
      )
    ) {
      this.flushAudio();
    }
    let chunk: Buffer;
    try {
      chunk = Buffer.from(audio.data, "base64");
    } catch {
      return;
    }
    if (!chunk.length) return;
    if (!isAudiblePcm16(chunk)) return;
    this.audioSampleRate = sampleRate;
    this.audioChannels = channels;
    this.audioItemId = itemId;
    this.audioChunks.push(chunk);
    this.outputStarted = true;
    this.clearOutputTimer();
    this.touch();
    this.scheduleAudioFlush();
    if (this.threadId !== threadId) this.flushAudio();
  }

  private scheduleAudioFlush(): void {
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.audioTimer = setTimeout(() => {
      this.audioTimer = undefined;
      this.flushAudio();
    }, this.options.audioQuietMs);
    this.audioTimer.unref();
  }

  private flushAudio(reportTextOnly = true): boolean {
    if (this.audioTimer) {
      clearTimeout(this.audioTimer);
      this.audioTimer = undefined;
    }
    this.clearOutputTimer();
    if (!this.audioChunks.length || !this.threadId) {
      const threadId = this.threadId;
      const transcript = this.assistantTranscript.trim() || undefined;
      const shouldReportTextOnly = Boolean(
        threadId
        && transcript
        && this.awaitingOutput
        && this.pendingInputKind === "task"
        && !this.intentionalStop
        && reportTextOnly
      );
      this.audioChunks = [];
      this.assistantTranscript = "";
      this.audioItemId = undefined;
      if (shouldReportTextOnly && threadId) {
        this.awaitingOutput = false;
        this.outputStarted = false;
        this.pendingInputKind = undefined;
        const failure = this.createFailure(
          threadId,
          "GPT-Live 返回了文字，但没有返回可发送的语音",
          transcript,
        );
        this.emit("failure", failure);
        return true;
      }
      return false;
    }
    const pcm = Buffer.concat(this.audioChunks);
    const durationMs = pcm.length * 1_000
      / (this.audioSampleRate * this.audioChannels * PCM_BYTES_PER_SAMPLE);
    if (durationMs < MIN_OUTPUT_AUDIO_MS) {
      const threadId = this.threadId;
      const pendingInputKind = this.pendingInputKind;
      this.audioChunks = [];
      this.audioItemId = undefined;
      this.outputStarted = false;
      if (reportTextOnly && threadId && pendingInputKind === "task") {
        this.armOutputTimeout(threadId, this.generation);
      }
      return false;
    }
    const utterance: RealtimeUtterance = {
      threadId: this.threadId,
      pcm,
      sampleRate: this.audioSampleRate,
      numChannels: this.audioChannels,
      transcript: this.assistantTranscript.trim() || undefined,
    };
    this.audioChunks = [];
    this.assistantTranscript = "";
    this.audioItemId = undefined;
    this.awaitingOutput = false;
    this.outputStarted = false;
    this.pendingInputKind = undefined;
    this.outputSequence += 1;
    this.emit("utterance", utterance);
    return true;
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.threadId) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.taskActive) {
        this.armIdleTimer();
        return;
      }
      void this.stop("idle-timeout");
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.clearOutputTimer();
    this.idleTimer = undefined;
    this.audioTimer = undefined;
  }

  private armOutputTimeout(threadId: string, generation: number): void {
    this.clearOutputTimer();
    this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      if (
        generation !== this.generation
        || this.threadId !== threadId
        || !this.awaitingOutput
        || this.pendingInputKind !== "task"
      ) return;
      const transcript = this.assistantTranscript.trim() || undefined;
      this.awaitingOutput = false;
      this.outputStarted = false;
      this.pendingInputKind = undefined;
      this.emitFailure(
        threadId,
        `GPT-Live 在 ${this.options.outputTimeoutMs}ms 内没有返回语音`,
        transcript,
      );
      void this.stop("output-timeout");
    }, this.options.outputTimeoutMs);
    this.outputTimer.unref();
  }

  private clearOutputTimer(): void {
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.outputTimer = undefined;
  }

  private emitFailure(
    threadId: string,
    message: string,
    transcript?: string,
  ): void {
    this.emit("failure", this.createFailure(threadId, message, transcript));
  }

  private createFailure(
    threadId: string,
    message: string,
    transcript?: string,
  ): RealtimeFailure {
    return {
      threadId,
      message,
      ...(transcript ? { transcript } : {}),
    };
  }

  private resetSession(): void {
    this.rejectStartAttempt(new Error("GPT-Live 会话已释放"));
    this.peer?.close();
    this.peer = undefined;
    this.threadId = undefined;
    this.connecting = false;
    this.active = false;
    this.taskActive = false;
    this.clientManagedHandoffs = false;
    this.sessionVersion = "v3";
    this.inputReadyAt = undefined;
    this.startPromise = undefined;
    this.audioChunks = [];
    this.assistantTranscript = "";
    this.audioItemId = undefined;
    this.awaitingOutput = false;
    this.outputStarted = false;
    this.pendingInputKind = undefined;
    this.intentionalStop = false;
  }

  private createWebRtcPeer(threadId: string): WebRtcAudioPeer {
    const peer = new WebRtcAudioPeer(this.logger);
    peer.on("audio", (frame: WebRtcAudioFrame) => {
      if (this.peer !== peer || this.threadId !== threadId) return;
      this.handlePcmAudio(frame);
    });
    peer.on("closed", (reason: string) => {
      if (this.peer !== peer || this.threadId !== threadId) return;
      if (this.startAttempt) {
        this.rejectStartAttempt(new Error(`WebRTC 在建连期间${reason}`));
        return;
      }
      const awaitingOutput = this.awaitingOutput;
      const pendingInputKind = this.pendingInputKind;
      const transcript = this.assistantTranscript.trim() || undefined;
      const outputCompleted = this.flushAudio(false);
      this.clearTimers();
      this.resetSession();
      if (awaitingOutput && !outputCompleted && pendingInputKind === "task") {
        this.emitFailure(threadId, `WebRTC 连接${reason}`, transcript);
      } else {
        this.emit("closed", { threadId, reason: `WebRTC 连接${reason}`, intentional: false });
      }
    });
    return peer;
  }

  private async waitUntilInputReady(threadId: string): Promise<void> {
    const delayMs = Math.max(0, (this.inputReadyAt ?? 0) - Date.now());
    if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    if (!this.active || this.threadId !== threadId) {
      throw new RealtimeDeliveryError("GPT-Live 会话在接受输入前已关闭", false);
    }
  }

  private async waitForOutputAfter(
    threadId: string,
    generation: number,
    outputSequence: number,
    timeoutMs = MIN_SPEECH_OUTPUT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.outputSequence > outputSequence) return;
      if (
        generation !== this.generation
        || !this.active
        || this.threadId !== threadId
      ) {
        throw new Error("GPT-Live 朗读期间会话已关闭");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${timeoutMs}ms 内没有收到 GPT-Live 朗读音频`);
  }

  private handlePcmAudio(frame: WebRtcAudioFrame): void {
    if (!frame.pcm.length) return;
    if (!isAudiblePcm16(frame.pcm)) return;
    if (
      this.audioChunks.length
      && (
        frame.sampleRate !== this.audioSampleRate
        || frame.numChannels !== this.audioChannels
      )
    ) {
      this.flushAudio();
    }
    this.audioSampleRate = frame.sampleRate;
    this.audioChannels = frame.numChannels;
    this.audioChunks.push(frame.pcm);
    this.outputStarted = true;
    this.touch();
    this.scheduleAudioFlush();
  }

  private beginStartAttempt(threadId: string, requireSdp: boolean): Promise<void> {
    this.rejectStartAttempt(new Error("新的 GPT-Live 建连已开始"));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => {
      this.rejectStartAttempt(new Error(`GPT-Live 在 ${this.options.startTimeoutMs}ms 内未完成建连`));
    }, this.options.startTimeoutMs);
    timer.unref();
    this.startAttempt = {
      threadId,
      requireSdp,
      started: false,
      sdpAccepted: !requireSdp,
      sdpPending: false,
      promise,
      resolve,
      reject,
      timer,
    };
    return promise;
  }

  private completeStartAttempt(): void {
    const attempt = this.startAttempt;
    if (!attempt || !attempt.started || !attempt.sdpAccepted) return;
    clearTimeout(attempt.timer);
    this.startAttempt = undefined;
    attempt.resolve();
  }

  private rejectStartAttempt(error: Error): void {
    const attempt = this.startAttempt;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    this.startAttempt = undefined;
    attempt.reject(error);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAudiblePcm16(pcm: Buffer): boolean {
  const byteLength = pcm.length - (pcm.length % PCM_BYTES_PER_SAMPLE);
  for (let offset = 0; offset < byteLength; offset += PCM_BYTES_PER_SAMPLE) {
    if (Math.abs(pcm.readInt16LE(offset)) >= OUTPUT_AUDIBLE_PEAK) return true;
  }
  return false;
}

export function toSpeakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "代码内容已省略。")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接已省略")
    .replace(/[A-Za-z]:\\[^\r\n，。；！？]+/g, "本地文件路径已省略")
    .replace(/^\s{0,3}(?:[-*+]|#{1,6}|>\s?|\d+[.)])\s*/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEAKABLE_TEXT_LENGTH);
}

export function speechOutputTimeoutMs(text: string): number {
  return Math.min(
    MAX_SPEECH_OUTPUT_TIMEOUT_MS,
    Math.max(MIN_SPEECH_OUTPUT_TIMEOUT_MS, toSpeakableText(text).length * 120),
  );
}
