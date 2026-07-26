import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { dataDirectory, dpapiScript } from "./paths.js";
import { EMPTY_STATE, type BridgeState } from "./types.js";

const outboxBaseSchema = {
  id: z.string(),
  to: z.string(),
  contextToken: z.string().optional(),
  createdAt: z.number(),
  attempts: z.number(),
  nextAttemptAt: z.number().optional(),
  lastError: z.string().optional(),
};

const outboxEntrySchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entry = value as Record<string, unknown>;
  return entry.kind ? entry : { ...entry, kind: "text" };
}, z.discriminatedUnion("kind", [
  z.object({ ...outboxBaseSchema, kind: z.literal("text"), text: z.string() }),
  z.object({
    ...outboxBaseSchema,
    kind: z.literal("file"),
    path: z.string(),
    name: z.string(),
    mediaKind: z.enum(["file", "audio"]),
    managed: z.boolean().optional(),
  }),
  z.object({
    ...outboxBaseSchema,
    kind: z.literal("speech"),
    threadId: z.string(),
    text: z.string(),
    fallbackText: z.string(),
    name: z.string(),
  }),
]));

const stateSchema = z.object({
  version: z.literal(1),
  credentials: z.object({
    botToken: z.string().min(1),
    botId: z.string().min(1),
    baseUrl: z.string().min(1),
    allowedUserId: z.string().min(1),
  }).optional(),
  syncBuf: z.string(),
  contextToken: z.string().optional(),
  boundThreadId: z.string().optional(),
  voiceModeEnabled: z.boolean().default(false),
  awaitingNewTaskRequest: z.boolean().optional(),
  pendingSelection: z.object({
    originalText: z.string().optional(),
    attachments: z.array(z.object({
      path: z.string(),
      kind: z.enum(["image", "file"]),
      name: z.string(),
    })).optional(),
    voiceReply: z.boolean().optional(),
    candidates: z.array(z.object({
      kind: z.enum(["thread", "project"]),
      id: z.string(),
      label: z.string(),
      cwd: z.string(),
    })),
  }).optional(),
  inbox: z.array(z.object({
    key: z.string(),
    message: z.record(z.string(), z.unknown()),
    status: z.enum(["received", "dispatched"]),
  })),
  processedIds: z.array(z.string()),
  activeTurn: z.object({
    threadId: z.string(),
    turnId: z.string(),
    sourceMessageKey: z.string(),
    startedAt: z.number(),
    replyTo: z.string().optional(),
    contextToken: z.string().optional(),
    phase: z.string().optional(),
    recentOperation: z.string().optional(),
    lastProgressAt: z.number().optional(),
    voiceReply: z.boolean().optional(),
  }).optional(),
  pendingUserInput: z.object({
    questions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.object({
        label: z.string(),
        description: z.string().optional(),
      })).nullable().optional(),
    })),
    receivedAt: z.number(),
  }).optional(),
  outbox: z.array(outboxEntrySchema).default([]),
});

async function runDpapi(mode: "protect" | "unprotect", input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", dpapiScript(), "-Mode", mode],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`DPAPI ${mode} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(input, "utf8");
  });
}

export class StateStore {
  private readonly file = path.join(dataDirectory(), "state.protected");
  private readonly writes = new RecoverableWriteQueue();

  async load(): Promise<BridgeState> {
    if (!fs.existsSync(this.file)) return structuredClone(EMPTY_STATE);
    const encrypted = fs.readFileSync(this.file, "utf8");
    const plain = await runDpapi("unprotect", encrypted);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain);
    } catch {
      throw new Error("DPAPI 状态解密成功，但内容不是有效 JSON；原文已隐藏");
    }
    return stateSchema.parse(parsed) as BridgeState;
  }

  async save(state: BridgeState): Promise<void> {
    const snapshot = JSON.stringify(state);
    await this.writes.run(async () => {
      const encrypted = await runDpapi("protect", snapshot);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, encrypted, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.file);
    });
  }
}

export class RecoverableWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  async run(task: () => Promise<void>): Promise<void> {
    const current = this.tail.catch(() => undefined).then(task);
    this.tail = current;
    await current;
  }
}
