import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeToResumeThread, inspectThreadActivity, staleOpenTurnIds } from "../src/codex/activity.js";

describe("thread activity guard", () => {
  let root: string;
  const threadId = "019f7e89-afe8-7c02-82c9-f4542ba73ef0";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-activity-"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeRollout(records: unknown[]): string {
    const directory = path.join(root, "2026", "07", "20");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `rollout-test-${threadId}.jsonl`);
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
    return file;
  }

  it("tracks unfinished turns by turn id", () => {
    writeRollout([
      { payload: { type: "task_started", turn_id: "turn-open" } },
      { payload: { type: "task_started", turn_id: "turn-done" } },
      { payload: { type: "task_complete", turn_id: "turn-done" } },
    ]);
    expect(inspectThreadActivity(threadId, [root])?.openTurnIds).toEqual([]);
  });

  it("treats turn_aborted as terminal and discards stale unmatched older turns", () => {
    writeRollout([
      { payload: { type: "task_started", turn_id: "stale-turn" } },
      { payload: { type: "task_started", turn_id: "new-turn" } },
      { payload: { type: "turn_aborted", turn_id: "new-turn" } },
    ]);
    const activity = inspectThreadActivity(threadId, [root]);
    expect(activity?.openTurnIds).toEqual([]);
    expect(activity?.latestTurnOpen).toBe(false);
  });

  it("rejects a recently unfinished turn but permits a stale crash marker", () => {
    const file = writeRollout([{ payload: { type: "task_started", turn_id: "turn-open" } }]);
    const modified = fs.statSync(file).mtimeMs;
    expect(() => assertSafeToResumeThread(threadId, modified + 20_000, [root])).toThrow(/拒绝并发接管/);
    expect(() => assertSafeToResumeThread(threadId, modified + 6 * 60_000, [root])).not.toThrow();
    expect(staleOpenTurnIds(inspectThreadActivity(threadId, [root]), modified + 6 * 60_000)).toEqual(["turn-open"]);

    writeRollout([
      { payload: { type: "task_started", turn_id: "turn-open" } },
      { payload: { type: "task_complete", turn_id: "turn-open" } },
    ]);
    const completedAt = fs.statSync(file).mtimeMs;
    expect(() => assertSafeToResumeThread(threadId, completedAt + 20_000, [root])).not.toThrow();
  });
});
