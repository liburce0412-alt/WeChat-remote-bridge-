import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeManager } from "../src/codex/realtime.js";
import { DeliveryQueue, retryDelayMs, VOICE_ATTACHMENT_NAME } from "../src/delivery.js";
import type { Logger } from "../src/logger.js";
import type { StateStore } from "../src/state.js";
import { EMPTY_STATE, type BridgeState } from "../src/types.js";
import type { WeixinClient } from "../src/weixin/client.js";

class FakeRealtime extends EventEmitter {
  async speak(threadId: string): Promise<void> {
    queueMicrotask(() => this.emit("utterance", {
      threadId,
      pcm: audiblePcm(2_400),
      sampleRate: 24_000,
      numChannels: 1,
      transcript: "完成了",
    }));
  }
}

describe("DeliveryQueue", () => {
  let directory: string;
  let state: BridgeState;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-delivery-"));
    process.env.WEIXIN_CODEX_DATA_DIR = directory;
    state = structuredClone(EMPTY_STATE);
  });

  afterEach(() => {
    delete process.env.WEIXIN_CODEX_DATA_DIR;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists speech, renders one WAV, sends it, then removes the managed file", async () => {
    const saves: string[] = [];
    const sent: Array<{ audio: Buffer; name: string; clientId?: string }> = [];
    const store = {
      save: async (snapshot: BridgeState) => {
        saves.push(JSON.stringify(snapshot.outbox));
      },
    } as unknown as StateStore;
    const weixin = {
      sendAudioFile: async (
        _to: string,
        audio: Buffer,
        name: string,
        _contextToken?: string,
        clientId?: string,
      ) => {
        sent.push({ audio, name, clientId });
      },
    } as unknown as WeixinClient;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const queue = new DeliveryQueue(
      () => state,
      () => weixin,
      store,
      new FakeRealtime() as unknown as RealtimeManager,
      logger,
      vi.fn(),
    );

    queue.enqueueSpeech("wx-user", "thread-1", "任务完成", "context-1");
    expect(state.outbox[0]).toMatchObject({ kind: "speech", fallbackText: "任务完成" });

    await queue.flush();

    expect(state.outbox).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe(VOICE_ATTACHMENT_NAME);
    expect(sent[0].audio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(sent[0].clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saves.length).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(path.join(directory, "media", "outbound"))).toEqual([]);
  });

  it("caps exponential retry delays at five minutes", () => {
    expect(retryDelayMs(1)).toBe(2_000);
    expect(retryDelayMs(2)).toBe(4_000);
    expect(retryDelayMs(99)).toBe(300_000);
  });
});

function audiblePcm(samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample += 1) pcm.writeInt16LE(1_000, sample * 2);
  return pcm;
}
