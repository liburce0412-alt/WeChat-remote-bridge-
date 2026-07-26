import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CODEX_VERSION = installedPackageVersion("@openai/codex") ?? "unknown";
export const WEIXIN_PROTOCOL_VERSION = "2.4.6";

export function dataDirectory(): string {
  return process.env.WEIXIN_CODEX_DATA_DIR
    ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "WeixinCodexBridge");
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function codexEntrypoint(): string {
  return path.join(PROJECT_ROOT, "node_modules", "@openai", "codex", "bin", "codex.js");
}

export function transcriberScript(): string {
  return path.join(PROJECT_ROOT, "scripts", "transcribe_worker.py");
}

export function dpapiScript(): string {
  return path.join(PROJECT_ROOT, "scripts", "dpapi.ps1");
}

export function heartbeatFile(): string {
  return path.join(dataDirectory(), "heartbeat.json");
}

export function threadSearchIndexFile(): string {
  return path.join(dataDirectory(), "thread-search-index.json");
}

export function isProjectPathAllowed(candidate: string): boolean {
  const configured = process.env.WEIXIN_CODEX_ALLOWED_ROOTS?.trim();
  if (!configured) return true;
  const target = path.resolve(candidate).toLocaleLowerCase();
  return configured
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .some((value) => {
      const root = path.resolve(value).toLocaleLowerCase();
      return target === root || target.startsWith(`${root}${path.sep}`);
    });
}

export function safeModeEnabled(): boolean {
  return process.env.WEIXIN_CODEX_SAFE_MODE === "1";
}

export function voiceAttachmentName(): string {
  const configured = process.env.WEIXIN_CODEX_AUDIO_FILENAME?.trim();
  const fileName = path.basename(configured || "GPT-Live语音.wav")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .trim();
  if (!fileName) return "GPT-Live语音.wav";
  return fileName.toLocaleLowerCase().endsWith(".wav") ? fileName : `${fileName}.wav`;
}

export function findWhisperModel(): string | undefined {
  const configured = process.env.WEIXIN_CODEX_WHISPER_MODEL;
  if (configured && fs.existsSync(configured)) return configured;
  const hub = path.join(os.homedir(), ".cache", "huggingface", "hub");
  const candidates = [
    "models--mobiuslabsgmbh--faster-whisper-large-v3-turbo",
    "models--Systran--faster-whisper-large-v3",
  ];
  for (const candidate of candidates) {
    const snapshots = path.join(hub, candidate, "snapshots");
    if (!fs.existsSync(snapshots)) continue;
    const snapshot = fs.readdirSync(snapshots)
      .map((name) => path.join(snapshots, name))
      .find((entry) => fs.statSync(entry).isDirectory());
    if (snapshot) return snapshot;
  }
  return undefined;
}

function installedPackageVersion(packageName: string): string | undefined {
  const parts = packageName.split("/");
  const manifest = path.join(PROJECT_ROOT, "node_modules", ...parts, "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
