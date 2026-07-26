import { afterAll, describe, expect, it } from "vitest";
import { CodexClient } from "../src/codex/client.js";
import { RealtimeManager, type RealtimeUtterance } from "../src/codex/realtime.js";
import { Logger } from "../src/logger.js";
import { PROJECT_ROOT } from "../src/paths.js";
import { StateStore } from "../src/state.js";
import { WeixinClient } from "../src/weixin/client.js";
import { pcm16ToWav } from "../src/weixin/media.js";

const enabled = process.env.RUN_REALTIME_INTEGRATION === "1";
const existingThreadId = process.env.REALTIME_EXISTING_THREAD_ID?.trim();
const sendWeixinE2e = process.env.RUN_WEIXIN_VOICE_E2E === "1";
const logger = new Logger(undefined, enabled ? "debug" : "warn");
const client = new CodexClient(logger);
const realtime = new RealtimeManager(client, logger, {
  model: process.env.WEIXIN_CODEX_REALTIME_MODEL?.trim() || "gpt-live-1-codex",
  voice: process.env.WEIXIN_CODEX_REALTIME_VOICE?.trim().toLowerCase() || "sol",
  transport: "webrtc",
  idleMs: 300_000,
  startTimeoutMs: 15_000,
  audioQuietMs: 600,
  outputTimeoutMs: 45_000,
});

describe.skipIf(!enabled)("GPT-Live app-server integration", () => {
  afterAll(async () => {
    await realtime.dispose();
    await client.stop();
  });

  it("turns appendSpeech text into PCM audio over the ChatGPT WebRTC transport", async () => {
    await client.start();
    const thread = await client.startThread(PROJECT_ROOT, true);
    const utterance = nextUtterance();

    const [, output] = await Promise.all([
      realtime.speak(thread.id, "语音链路测试成功。"),
      utterance,
    ]);
    expect(output.threadId).toBe(thread.id);
    expect(output.sampleRate).toBe(24_000);
    expect(output.numChannels).toBe(1);
    expect(output.pcm.length).toBeGreaterThan(4_800);
    expect(output.transcript).toMatch(/[\u3400-\u9fff]/u);
    expect(output.transcript).not.toMatch(/^[\x00-\x7f]+$/u);
  }, 90_000);

  it("turns transcribed voice text into GPT-Live audio", async () => {
    await client.start();
    const thread = await client.startThread(PROJECT_ROOT, true);
    const utterance = nextUtterance();

    const [, output] = await Promise.all([
      realtime.sendText(thread.id, "请只回答：微信语音文字链路测试成功。"),
      utterance,
    ]);

    expect(output.threadId).toBe(thread.id);
    expect(output.sampleRate).toBe(24_000);
    expect(output.numChannels).toBe(1);
    expect(output.pcm.length).toBeGreaterThan(4_800);
  }, 90_000);

  it.skipIf(!existingThreadId)("returns GPT-Live audio on an existing resumed task", async () => {
    await client.start();
    await client.resumeThread(existingThreadId!);
    const utterance = nextUtterance();

    const [, output] = await Promise.all([
      realtime.sendText(existingThreadId!, "请只回答：绑定任务语音链路测试成功。"),
      utterance,
    ]);

    expect(output.threadId).toBe(existingThreadId);
    expect(output.pcm.length).toBeGreaterThan(4_800);
  }, 90_000);

  it.skipIf(!existingThreadId || !sendWeixinE2e)("sends generated GPT-Live audio to Weixin", async () => {
    await client.start();
    await client.resumeThread(existingThreadId!);
    const utterance = nextUtterance();
    const [, output] = await Promise.all([
      realtime.sendText(existingThreadId!, "请只回答：微信端到端语音链路测试成功。"),
      utterance,
    ]);
    const state = await new StateStore().load();
    if (!state.credentials) throw new Error("微信尚未配置");
    const audio = pcm16ToWav(output.pcm, output.sampleRate, output.numChannels);
    const weixin = new WeixinClient(state.credentials.baseUrl, state.credentials.botToken, logger);

    await weixin.sendAudioFile(
      state.credentials.allowedUserId,
      audio,
      "GPT-Live端到端测试.wav",
      state.contextToken,
    );

    expect(audio.length).toBeGreaterThan(4_844);
  }, 90_000);

});

function nextUtterance(): Promise<RealtimeUtterance> {
  return new Promise<RealtimeUtterance>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      realtime.off("utterance", onUtterance);
      realtime.off("failure", onFailure);
    };
    const onUtterance = (value: RealtimeUtterance) => {
      cleanup();
      resolve(value);
    };
    const onFailure = (failure: unknown) => {
      cleanup();
      reject(new Error(JSON.stringify(failure)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("等待 GPT-Live 音频超时"));
    }, 45_000);
    realtime.once("utterance", onUtterance);
    realtime.once("failure", onFailure);
  });
}
