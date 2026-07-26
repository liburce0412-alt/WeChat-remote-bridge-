import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { decode } from "silk-wasm";
import { dataDirectory } from "../paths.js";
import type { CdnMedia } from "./types.js";

function parseAesKey(value: string): Buffer {
  if (/^[0-9a-f]{32}$/i.test(value)) return Buffer.from(value, "hex");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`不支持的微信语音 AES key 长度: ${decoded.length}`);
}

async function downloadBuffer(media: CdnMedia, cdnBaseUrl: string, aesKey?: string): Promise<Buffer> {
  const url = media.full_url
    ?? `${cdnBaseUrl.replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? "")}`;
  let cipherText: Buffer | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    timer.unref();
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`微信媒体下载失败: HTTP ${response.status}`);
      cipherText = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    } finally {
      clearTimeout(timer);
    }
  }
  if (!cipherText) {
    throw lastError instanceof Error ? lastError : new Error("微信媒体下载失败");
  }
  if (cipherText.length > 100 * 1024 * 1024) throw new Error("微信媒体超过 100MB 限制");
  const key = aesKey ?? media.aes_key;
  if (!key) return cipherText;
  const decipher = crypto.createDecipheriv("aes-128-ecb", parseAesKey(key), null);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

export function pcm16ToWav(pcm: Uint8Array, sampleRate: number, numChannels = 1): Buffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error(`无效 PCM 采样率: ${sampleRate}`);
  if (!Number.isSafeInteger(numChannels) || numChannels <= 0) throw new Error(`无效 PCM 声道数: ${numChannels}`);
  const output = Buffer.allocUnsafe(44 + pcm.byteLength);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(numChannels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * numChannels * 2, 28);
  output.writeUInt16LE(numChannels * 2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(output, 44);
  return output;
}

export async function downloadVoicePcm(media: CdnMedia, cdnBaseUrl: string): Promise<Buffer> {
  if (!media.aes_key) throw new Error("微信语音缺少 aes_key");
  const silk = await downloadBuffer(media, cdnBaseUrl);
  const decoded = await decode(silk, 24_000);
  return Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
}

export function writeTemporaryPcmWav(pcm: Uint8Array, sampleRate: number, numChannels = 1): string {
  const wav = pcm16ToWav(pcm, sampleRate, numChannels);
  const dir = path.join(dataDirectory(), "media");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voice-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.wav`);
  fs.writeFileSync(file, wav);
  return file;
}

export async function downloadAttachment(
  media: CdnMedia,
  cdnBaseUrl: string,
  options: { fileName?: string; aesKey?: string; image?: boolean } = {},
): Promise<string> {
  const buffer = await downloadBuffer(media, cdnBaseUrl, options.aesKey);
  const dir = path.join(dataDirectory(), "media", "inbound");
  fs.mkdirSync(dir, { recursive: true });
  const requested = options.fileName ? path.basename(options.fileName) : undefined;
  const extension = requested ? path.extname(requested) : options.image ? detectImageExtension(buffer) : ".bin";
  const stem = requested ? path.basename(requested, path.extname(requested)) : options.image ? "image" : "file";
  const safeStem = stem.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 80) || "attachment";
  const file = path.join(dir, `${safeStem}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

function detectImageExtension(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".jpg";
}
