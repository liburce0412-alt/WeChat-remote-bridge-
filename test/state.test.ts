import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state.js";

describe("StateStore", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-state-"));
    process.env.WEIXIN_CODEX_DATA_DIR = directory;
  });

  afterEach(() => {
    delete process.env.WEIXIN_CODEX_DATA_DIR;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips encrypted state with Windows DPAPI", async () => {
    const store = new StateStore();
    const state = await store.load();
    state.credentials = {
      botToken: "secret-token",
      botId: "bot-id",
      baseUrl: "https://example.test",
      allowedUserId: "wx-user",
    };
    state.syncBuf = "opaque-cursor";
    state.voiceModeEnabled = true;
    state.processedIds.push("message-1");
    state.activeTurn = {
      threadId: "thread-1",
      turnId: "turn-1",
      sourceMessageKey: "message-1",
      startedAt: 123456789,
    };
    state.outbox.push({
      id: "reply-1",
      kind: "text",
      to: "wx-user",
      text: "执行完成",
      contextToken: "context-token",
      createdAt: 123456790,
      attempts: 0,
    });
    state.outbox.push({
      id: "speech-1",
      kind: "speech",
      to: "wx-user",
      threadId: "thread-1",
      text: "执行完成",
      fallbackText: "执行完成",
      name: "GPT-Live语音.wav",
      createdAt: 123456791,
      attempts: 0,
    });
    state.outbox.push({
      id: "audio-1",
      kind: "file",
      to: "wx-user",
      path: "C:\\temp\\audio.wav",
      name: "GPT-Live语音.wav",
      mediaKind: "audio",
      managed: true,
      createdAt: 123456792,
      attempts: 1,
    });
    state.pendingSelection = {
      originalText: "好了",
      page: 1,
      candidates: [{
        kind: "thread",
        id: "thread-1",
        label: "中文任务",
        cwd: "C:\\测试",
      }],
    };
    await store.save(state);

    const raw = fs.readFileSync(path.join(directory, "state.protected"), "utf8");
    expect(raw).not.toContain("secret-token");
    await expect(new StateStore().load()).resolves.toEqual(state);
  });

  it("recovers the serialized write queue after one failed operation", async () => {
    const { RecoverableWriteQueue } = await import("../src/state.js");
    const queue = new RecoverableWriteQueue();
    await expect(queue.run(async () => {
      throw new Error("disk full");
    })).rejects.toThrow("disk full");

    let completed = false;
    await queue.run(async () => {
      completed = true;
    });
    expect(completed).toBe(true);
  });
});
