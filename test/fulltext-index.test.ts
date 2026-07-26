import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchLocalThreadIndex } from "../src/codex/fulltext-index.js";

describe("local Codex full-text fallback", () => {
  let root: string;
  const threadId = "019f7e89-afe8-7c02-82c9-f4542ba73ef0";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fulltext-"));
    process.env.CODEX_HOME = root;
    process.env.WEIXIN_CODEX_DATA_DIR = root;
  });

  afterEach(() => {
    delete process.env.CODEX_HOME;
    delete process.env.WEIXIN_CODEX_DATA_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds titles and real conversation text while ignoring base instructions", async () => {
    fs.writeFileSync(path.join(root, "session_index.jsonl"), JSON.stringify({
      id: threadId,
      thread_name: "微信桥接任务",
      updated_at: "2026-07-20T00:00:00Z",
    }), "utf8");
    const directory = path.join(root, "sessions", "2026", "07", "20");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `rollout-${threadId}.jsonl`), [
      { type: "session_meta", payload: { base_instructions: { text: "不应命中秘密词" } } },
      { type: "event_msg", payload: { type: "user_message", message: "请修复 watchdog 弹窗" } },
    ].map((record) => JSON.stringify(record)).join("\n"), "utf8");

    expect((await searchLocalThreadIndex("微信桥接", 5))[0]?.threadId).toBe(threadId);
    expect((await searchLocalThreadIndex("watchdog", 5))[0]?.snippet).toContain("watchdog");
    expect(await searchLocalThreadIndex("秘密词", 5)).toEqual([]);
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(root, "thread-search-index.json"))).toBe(true);
    });
  });
});
