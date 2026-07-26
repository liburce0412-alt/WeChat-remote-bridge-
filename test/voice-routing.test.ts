import { afterEach, describe, expect, it } from "vitest";
import { voiceAttachmentName } from "../src/paths.js";

afterEach(() => {
  delete process.env.WEIXIN_CODEX_AUDIO_FILENAME;
});

describe("voice attachment name", () => {
  it("uses a generic public default", () => {
    expect(voiceAttachmentName()).toBe("GPT-Live语音.wav");
  });

  it("allows a private override and keeps the value as a safe WAV filename", () => {
    process.env.WEIXIN_CODEX_AUDIO_FILENAME = "..\\My Assistant";
    expect(voiceAttachmentName()).toBe("My Assistant.wav");
  });
});
