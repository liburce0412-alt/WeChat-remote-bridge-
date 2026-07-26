import { describe, expect, it } from "vitest";
import {
  findCandidateIndex,
  formatCandidates,
  sanitizeBridgeOutput,
  shouldSendTextResult,
} from "../src/bridge.js";
import type { SelectionCandidate } from "../src/types.js";

describe("sanitizeBridgeOutput", () => {
  it("removes the internal completion marker from the start of a reply", () => {
    expect(sanitizeBridgeOutput("[COMPLETE] 好的，我们继续。")).toBe("好的，我们继续。");
  });

  it("preserves completion text that is part of the reply body", () => {
    expect(sanitizeBridgeOutput("示例：[COMPLETE]")).toBe("示例：[COMPLETE]");
  });
});

describe("voice result delivery", () => {
  it("does not duplicate a successful voice result as text", () => {
    expect(shouldSendTextResult(true, false)).toBe(false);
    expect(shouldSendTextResult(false, false)).toBe(true);
  });

  it("keeps a text fallback when the task failed", () => {
    expect(shouldSendTextResult(true, true)).toBe(true);
  });
});

describe("task selection display", () => {
  const candidates: SelectionCandidate[] = [
    { kind: "thread", id: "thread-1", label: "剪辑工作流", cwd: "C:\\work\\clip" },
    { kind: "thread", id: "thread-2", label: "制定阶段一MVP计划", cwd: "C:\\work\\mvp" },
  ];

  it("shows simple numbered task names without type labels or paths", () => {
    const output = formatCandidates(candidates);

    expect(output).toContain("1. 剪辑工作流");
    expect(output).toContain("2. 制定阶段一MVP计划");
    expect(output).not.toMatch(/\[任务]|C:\\work/);
    expect(output).toContain("请回复序号或任务名称");
  });

  it("selects by exact or unique partial task name", () => {
    expect(findCandidateIndex(candidates, "制定阶段一MVP计划")).toBe(1);
    expect(findCandidateIndex(candidates, "剪辑")).toBe(0);
    expect(findCandidateIndex(candidates, "不存在")).toBe(-1);
  });

  it("selects numbered replies", () => {
    expect(findCandidateIndex(candidates, "2")).toBe(1);
  });
});
