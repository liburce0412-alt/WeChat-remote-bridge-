import { describe, expect, it } from "vitest";
import { VOICE_ATTACHMENT_NAME } from "../src/bridge.js";

describe("voice replies", () => {
  it("uses the fixed user-facing attachment name", () => {
    expect(VOICE_ATTACHMENT_NAME).toBe("迟迟的语音.wav");
  });
});
