import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/logger.js";
import type {
  CodexNotification,
  RealtimeAudioChunk,
  RealtimeStartOptions,
} from "../src/codex/client.js";
import {
  RealtimeManager,
  SPEECH_RENDERER_PROMPT,
  speechOutputTimeoutMs,
  toSpeakableText,
  type RealtimeManagerOptions,
  type RealtimeTransport,
  type RealtimeUtterance,
} from "../src/codex/realtime.js";

class FakeTransport extends EventEmitter implements RealtimeTransport {
  starts: Array<{ threadId: string; options: RealtimeStartOptions; timeoutMs?: number }> = [];
  texts: Array<{ threadId: string; text: string }> = [];
  audio: Array<{ threadId: string; audio: RealtimeAudioChunk }> = [];
  speech: Array<{ threadId: string; text: string }> = [];
  stops: string[] = [];
  startErrors: Error[] = [];

  async startRealtime(threadId: string, options: RealtimeStartOptions, timeoutMs?: number): Promise<void> {
    this.starts.push({ threadId, options, timeoutMs });
    const error = this.startErrors.shift();
    if (error) throw error;
    queueMicrotask(() => this.notify({
      method: "thread/realtime/started",
      params: { threadId, realtimeSessionId: "session-1", version: "v3" },
    }));
  }

  async appendRealtimeText(threadId: string, text: string): Promise<void> {
    this.texts.push({ threadId, text });
  }

  async appendRealtimeAudio(threadId: string, audio: RealtimeAudioChunk): Promise<void> {
    this.audio.push({ threadId, audio });
  }

  async appendRealtimeSpeech(threadId: string, text: string): Promise<void> {
    this.speech.push({ threadId, text });
  }

  async stopRealtime(threadId: string): Promise<void> {
    this.stops.push(threadId);
  }

  notify(notification: CodexNotification): void {
    this.emit("notification", notification);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const options: RealtimeManagerOptions = {
  model: "gpt-live-1-codex",
  voice: "sol",
  transport: "websocket",
  idleMs: 1_000,
  startTimeoutMs: 15_000,
  audioQuietMs: 25,
  outputTimeoutMs: 250,
};

let manager: RealtimeManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  vi.useRealTimers();
});

describe("RealtimeManager", () => {
  it("retries once with Codex default model", async () => {
    const transport = new FakeTransport();
    transport.startErrors.push(new Error("model unavailable"));
    manager = new RealtimeManager(transport, logger, options);

    await manager.start("thread-1");

    expect(transport.starts).toHaveLength(2);
    expect(transport.starts[0].options.model).toBe("gpt-live-1-codex");
    expect(transport.starts[0].timeoutMs).toBe(15_000);
    expect(transport.starts[1].options.model).toBeUndefined();
    expect(transport.starts[1].options).toMatchObject({ voice: "sol", version: "v3" });
  });

  it("starts client-managed speech with a no-translation prompt", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);

    const speaking = manager.speak("thread-1", "今天天气很好。");
    await vi.waitFor(() => expect(transport.speech).toHaveLength(1));
    transport.notify({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: {
          data: audiblePcm(2_400).toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 1_200,
          itemId: "speech-1",
        },
      },
    });
    await speaking;

    expect(transport.starts[0].options).toMatchObject({
      clientManagedHandoffs: true,
      prompt: SPEECH_RENDERER_PROMPT,
    });
    expect(SPEECH_RENDERER_PROMPT).toContain("Never translate");
  });

  it("ignores a delayed requested close from the previous start attempt", async () => {
    class RetryTransport extends FakeTransport {
      override async startRealtime(
        threadId: string,
        startOptions: RealtimeStartOptions,
        timeoutMs?: number,
      ): Promise<void> {
        this.starts.push({ threadId, options: startOptions, timeoutMs });
        if (this.starts.length === 1) throw new Error("first attempt timed out");
        this.notify({
          method: "thread/realtime/closed",
          params: { threadId, reason: "requested" },
        });
        queueMicrotask(() => this.notify({
          method: "thread/realtime/started",
          params: { threadId, realtimeSessionId: "session-2", version: "v3" },
        }));
      }
    }
    const transport = new RetryTransport();
    manager = new RealtimeManager(transport, logger, options);

    await manager.start("thread-1");

    expect(manager.getStatus().active).toBe(true);
    expect(transport.starts).toHaveLength(2);
  });

  it("sends PCM16 mono in 20ms chunks and appends a VAD silence tail", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const pcm40ms = Buffer.alloc(24_000 * 2 * 40 / 1_000, 7);

    await manager.sendPcm("thread-1", pcm40ms);

    expect(transport.audio).toHaveLength(27);
    expect(transport.audio.every(({ audio }) => (
      audio.sampleRate === 24_000
      && audio.numChannels === 1
      && audio.samplesPerChannel === 480
      && Buffer.from(audio.data, "base64").length === 960
    ))).toBe(true);
    expect(Buffer.from(transport.audio[0].audio.data, "base64").every((value) => value === 7)).toBe(true);
    expect(Buffer.from(transport.audio.at(-1)!.audio.data, "base64").every((value) => value === 0)).toBe(true);
  });

  it("merges output chunks and flushes one utterance after transcript completion", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const utterances: RealtimeUtterance[] = [];
    manager.on("utterance", (utterance: RealtimeUtterance) => utterances.push(utterance));
    await manager.start("thread-1");

    const completeReply = audiblePcm(2_400);
    for (const pcm of [completeReply.subarray(0, 2_400), completeReply.subarray(2_400)]) {
      transport.notify({
        method: "thread/realtime/outputAudio/delta",
        params: {
          threadId: "thread-1",
          audio: {
            data: pcm.toString("base64"),
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: pcm.length / 2,
            itemId: "audio-1",
          },
        },
      });
    }
    transport.notify({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "完成了" },
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(utterances).toHaveLength(1);
    expect(utterances[0].pcm).toEqual(completeReply);
    expect(utterances[0].transcript).toBe("完成了");
  });

  it("ignores continuous silent output frames and flushes after audible speech stops", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const utterances: RealtimeUtterance[] = [];
    manager.on("utterance", (utterance: RealtimeUtterance) => utterances.push(utterance));
    await manager.start("thread-1");

    transport.notify({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: {
          data: Buffer.alloc(960).toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 480,
          itemId: "audio-1",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(utterances).toEqual([]);

    const audible = audiblePcm(2_400);
    transport.notify({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: {
          data: audible.toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 2_400,
          itemId: "audio-1",
        },
      },
    });
    transport.notify({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: {
          data: Buffer.alloc(960).toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 480,
          itemId: "audio-1",
        },
      },
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(utterances).toHaveLength(1);
    expect(utterances[0].pcm).toEqual(audible);
  });

  it("keeps multiple assistant audio turns separate", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const utterances: RealtimeUtterance[] = [];
    manager.on("utterance", (utterance: RealtimeUtterance) => utterances.push(utterance));
    await manager.start("thread-1");

    for (const [itemId, value, transcript] of [["one", 1, "进度"], ["two", 2, "结果"]] as const) {
      const pcm = audiblePcm(2_400, value * 1_000);
      transport.notify({
        method: "thread/realtime/outputAudio/delta",
        params: {
          threadId: "thread-1",
          audio: {
            data: pcm.toString("base64"),
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: 2_400,
            itemId,
          },
        },
      });
      transport.notify({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "assistant", text: transcript },
      });
      await vi.advanceTimersByTimeAsync(25);
    }

    expect(utterances.map(({ transcript }) => transcript)).toEqual(["进度", "结果"]);
  });

  it("reports the transcript when the realtime session fails", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    await manager.start("thread-1");
    await manager.sendText("thread-1", "开始处理");

    transport.notify({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "已经处理一半" },
    });
    transport.notify({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "network lost" },
    });

    expect(failures).toEqual([{
      threadId: "thread-1",
      message: "network lost",
      transcript: "已经处理一半",
    }]);
    expect(manager.getStatus().active).toBe(false);
  });

  it("keeps the next session on V3 after a usage limit", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    await manager.start("thread-1");
    await manager.sendText("thread-1", "你好");

    transport.notify({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "You have reached your usage limit." },
    });
    await manager.start("thread-1");

    expect(failures).toEqual([{
      threadId: "thread-1",
      message: "You have reached your usage limit.",
    }]);
    expect(transport.starts.at(-1)?.options).toMatchObject({ version: "v3", voice: "sol" });
    expect(transport.starts.at(-1)?.options.model).toBe("gpt-live-1-codex");
  });

  it("reports repeated usage limits without claiming a compatibility switch", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    await manager.start("thread-1");
    await manager.sendText("thread-1", "第一次");
    transport.notify({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "You have reached your usage limit." },
    });
    await manager.start("thread-1");
    await manager.sendText("thread-1", "第二次");

    transport.notify({
      method: "thread/realtime/error",
      params: { threadId: "thread-1", message: "You have reached your usage limit." },
    });

    expect(failures.at(-1)).toEqual({
      threadId: "thread-1",
      message: "You have reached your usage limit.",
    });
    expect(transport.starts.at(-1)?.options).toMatchObject({ version: "v3", voice: "sol" });
  });

  it("reports a text-only realtime response instead of silently discarding it", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    await manager.start("thread-1");
    await manager.sendText("thread-1", "你好");

    transport.notify({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "只能返回文字" },
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(failures).toEqual([{
      threadId: "thread-1",
      message: "GPT-Live 返回了文字，但没有返回可发送的语音",
      transcript: "只能返回文字",
    }]);
    await manager.start("thread-1");
    expect(transport.starts.at(-1)?.options).toMatchObject({ version: "v3", voice: "sol" });
  });

  it("reports an output timeout instead of leaving a Weixin voice message unanswered", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    await manager.start("thread-1");
    await manager.sendText("thread-1", "你好");

    await vi.advanceTimersByTimeAsync(250);

    expect(failures).toEqual([{
      threadId: "thread-1",
      message: "GPT-Live 在 250ms 内没有返回语音",
    }]);
    expect(transport.stops).toContain("thread-1");
    await manager.start("thread-1");
    expect(transport.starts.at(-1)?.options).toMatchObject({ version: "v3", voice: "sol" });
  });

  it("times out a hanging appendText request", async () => {
    vi.useFakeTimers();
    class HangingTextTransport extends FakeTransport {
      override async appendRealtimeText(threadId: string, text: string): Promise<void> {
        this.texts.push({ threadId, text });
        await new Promise<void>(() => undefined);
      }
    }
    const transport = new HangingTextTransport();
    manager = new RealtimeManager(transport, logger, { ...options, idleMs: 100_000 });

    const input = manager.sendText("thread-1", "你好");
    const rejected = expect(input).rejects.toThrow("12000ms 内没有提交完成");
    await vi.advanceTimersByTimeAsync(12_000);

    await rejected;
    expect(transport.texts).toHaveLength(1);
    expect(transport.stops).toEqual(["thread-1"]);
  });

  it("times out a hanging appendSpeech request and safely retries once", async () => {
    vi.useFakeTimers();
    class HangingSpeechTransport extends FakeTransport {
      override async appendRealtimeSpeech(threadId: string, text: string): Promise<void> {
        this.speech.push({ threadId, text });
        await new Promise<void>(() => undefined);
      }
    }
    const transport = new HangingSpeechTransport();
    manager = new RealtimeManager(transport, logger, { ...options, idleMs: 100_000 });

    const speech = manager.speak("thread-1", "完成了");
    const rejected = expect(speech).rejects.toThrow("30000ms 内没有收到 GPT-Live 朗读音频");
    await vi.advanceTimersByTimeAsync(60_000);

    await rejected;
    expect(transport.speech).toHaveLength(2);
    expect(transport.stops).toEqual(["thread-1"]);
  });

  it("normalizes long Markdown results before speech and scales the timeout", () => {
    const text = toSpeakableText([
      "# 结果",
      "请查看 [报告](C:\\work\\report.md) 和 https://example.test/very/long/url。",
      "```ts",
      "console.log('not spoken');",
      "```",
      "完成。",
    ].join("\n"));

    expect(text).toContain("结果");
    expect(text).toContain("报告");
    expect(text).toContain("代码内容已省略");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("console.log");
    expect(speechOutputTimeoutMs("短句")).toBe(30_000);
    expect(speechOutputTimeoutMs("长".repeat(1_000))).toBe(120_000);
  });

  it("does not report a failure when the session closes after audio was delivered", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const failures: unknown[] = [];
    const closed: unknown[] = [];
    const utterances: RealtimeUtterance[] = [];
    manager.on("failure", (failure) => failures.push(failure));
    manager.on("closed", (event) => closed.push(event));
    manager.on("utterance", (utterance: RealtimeUtterance) => utterances.push(utterance));
    await manager.speak("thread-1", "完成了");

    transport.notify({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: {
          data: audiblePcm(2_400).toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 2_400,
          itemId: "audio-1",
        },
      },
    });
    transport.notify({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "stream ended" },
    });

    expect(utterances).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(closed).toHaveLength(1);
  });

  it("ignores a short audible blip before a complete reply", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    const utterances: RealtimeUtterance[] = [];
    manager.on("utterance", (utterance: RealtimeUtterance) => utterances.push(utterance));
    await manager.sendText("thread-1", "你好");

    for (const samples of [240, 2_400]) {
      transport.notify({
        method: "thread/realtime/outputAudio/delta",
        params: {
          threadId: "thread-1",
          audio: {
            data: audiblePcm(samples).toString("base64"),
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: samples,
            itemId: "audio-1",
          },
        },
      });
      await vi.advanceTimersByTimeAsync(25);
    }

    expect(utterances).toHaveLength(1);
    expect(utterances[0].pcm.length).toBe(4_800);
  });

  it("does not idle-close while Codex is active, then closes after completion", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, { ...options, idleMs: 100 });
    await manager.start("thread-1");
    transport.notify({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active" } },
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(transport.stops).toEqual([]);

    transport.notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(transport.stops).toEqual(["thread-1"]);
  });

  it("actively stops and releases the current thread", async () => {
    const transport = new FakeTransport();
    manager = new RealtimeManager(transport, logger, options);
    await manager.start("thread-1");

    await manager.stop("test");

    expect(transport.stops).toEqual(["thread-1"]);
    expect(manager.getStatus().threadId).toBeUndefined();
  });
});

function audiblePcm(samples: number, value = 1_000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample += 1) {
    pcm.writeInt16LE(value, sample * 2);
  }
  return pcm;
}
