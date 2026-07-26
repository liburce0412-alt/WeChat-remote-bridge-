import fs from "node:fs";
import path from "node:path";
import { codexHome } from "../paths.js";

export const STALE_OPEN_TURN_MS = 5 * 60_000;

export interface ThreadActivity {
  rolloutPath: string;
  lastWriteAt: number;
  openTurnIds: string[];
  latestTurnOpen: boolean;
}

export function inspectThreadActivity(
  threadId: string,
  roots = [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")],
): ThreadActivity | undefined {
  const rolloutPath = roots
    .map((root) => findRollout(root, threadId))
    .find((candidate): candidate is string => Boolean(candidate));
  if (!rolloutPath) return undefined;

  const openTurns = new Set<string>();
  for (const line of fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)) {
    if (!line.includes('"task_started"') && !line.includes('"task_complete"') && !line.includes('"turn_aborted"')) continue;
    try {
      const record = JSON.parse(line) as { payload?: { type?: string; turn_id?: string } };
      const turnId = record.payload?.turn_id;
      if (!turnId) continue;
      if (record.payload?.type === "task_started") {
        // A thread can only have one legitimate active turn. A newer start proves
        // an older unmatched marker was left behind by a crash or hard stop.
        openTurns.clear();
        openTurns.add(turnId);
      }
      if (record.payload?.type === "task_complete" || record.payload?.type === "turn_aborted") {
        openTurns.delete(turnId);
      }
    } catch {
      // A partially written final line is not evidence that a task is idle.
    }
  }

  return {
    rolloutPath,
    lastWriteAt: fs.statSync(rolloutPath).mtimeMs,
    openTurnIds: [...openTurns],
    latestTurnOpen: openTurns.size > 0,
  };
}

export function assertSafeToResumeThread(
  threadId: string,
  now = Date.now(),
  roots?: string[],
): void {
  const activity = inspectThreadActivity(threadId, roots);
  if (!activity) return;
  const ageMs = Math.max(0, now - activity.lastWriteAt);
  if (activity.latestTurnOpen && ageMs < STALE_OPEN_TURN_MS) {
    throw new Error("该桌面任务仍有活动 turn，Bridge 已拒绝并发接管。请先停止桌面任务，等待约 1 分钟后重试，或改为新任务");
  }
  if (activity.latestTurnOpen) return;
  if (ageMs < 15_000) {
    throw new Error("该桌面任务刚刚仍在写入，Bridge 已拒绝接管。请确认桌面任务停止后稍候重试");
  }
}

export function staleOpenTurnIds(activity: ThreadActivity | undefined, now = Date.now()): string[] {
  if (!activity?.latestTurnOpen) return [];
  return now - activity.lastWriteAt >= STALE_OPEN_TURN_MS ? activity.openTurnIds : [];
}

function findRollout(root: string, threadId: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
        return fullPath;
      }
    }
  }
  return undefined;
}
