import { afterAll, describe, expect, it } from "vitest";
import { Logger } from "../src/logger.js";
import { Transcriber } from "../src/transcription.js";

const enabled = process.env.RUN_TRANSCRIBER_INTEGRATION === "1";
const transcriber = new Transcriber(new Logger(undefined, "error"));

describe.skipIf(!enabled)("local faster-whisper integration", () => {
  afterAll(() => transcriber.stop());

  it("loads the existing CUDA model", async () => {
    await expect(transcriber.start()).resolves.toBeUndefined();
  }, 120_000);
});
