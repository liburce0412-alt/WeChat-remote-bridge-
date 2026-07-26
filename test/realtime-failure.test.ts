import { describe, expect, it } from "vitest";
import { formatRealtimeFailureText } from "../src/bridge.js";

describe("formatRealtimeFailureText", () => {
  it("explains a usage limit without claiming an unavailable V1 fallback", () => {
    expect(formatRealtimeFailureText({
      threadId: "thread-1",
      message: "You have reached your usage limit.",
    })).not.toContain("V1");
  });

  it("preserves a transcript when audio is missing", () => {
    expect(formatRealtimeFailureText({
      threadId: "thread-1",
      message: "GPT-Live 返回了文字，但没有返回可发送的语音",
      transcript: "这是文字结果",
    })).toContain("这是文字结果");
  });

  it("reports a silent session without claiming an unavailable V1 fallback", () => {
    expect(formatRealtimeFailureText({
      threadId: "thread-1",
      message: "GPT-Live 在 30000ms 内没有返回语音",
    })).not.toContain("V1");
  });
});
