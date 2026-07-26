import { describe, expect, it } from "vitest";
import { getWavFileInfo } from "silk-wasm";
import { pcm16ToWav } from "../src/weixin/media.js";
import { normalizeWebRtcAudio } from "../src/codex/webrtc-peer.js";

describe("GPT-Live PCM to Weixin audio attachment", () => {
  it("writes a 24kHz mono PCM16 WAV header", () => {
    const pcm = Buffer.alloc(24_000 * 2);
    const wav = pcm16ToWav(pcm, 24_000);
    const info = getWavFileInfo(wav);

    expect(info.fmt).toMatchObject({
      formatCode: 1,
      numberOfChannels: 1,
      sampleRate: 24_000,
      bytesPerSec: 48_000,
      bytesPerFrame: 2,
      bitsPerSample: 16,
    });
    expect(info.chunkInfo.find(({ chunkId }) => chunkId === "data")?.dataLength).toBe(pcm.length);
  });

  it("downmixes and resamples a WebRTC 48kHz stereo frame to 24kHz mono", () => {
    const input = new Int16Array([
      1_000, 3_000,
      2_000, 4_000,
      -1_000, -3_000,
      -2_000, -4_000,
    ]);
    const output = normalizeWebRtcAudio(input, 48_000, 2, 4);

    expect(output.length).toBe(4);
    expect(output.readInt16LE(0)).toBe(2_000);
    expect(output.readInt16LE(2)).toBe(-2_000);
  });
});
