import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import { Logger } from "../logger.js";
import {
  codexEntrypoint,
  codexHome,
  CODEX_VERSION,
  isProjectPathAllowed,
  PROJECT_ROOT,
  safeModeEnabled,
} from "../paths.js";
import type { CodexThread, ThreadSearchResult, TurnAttachment, TurnResult } from "../types.js";
import { searchLocalThreadIndex } from "./fulltext-index.js";

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

interface TurnTracker {
  threadId: string;
  turnId: string;
  text: string;
  resolve: (result: TurnResult) => void;
  completion: Promise<TurnResult>;
}

export interface ServerRequestEvent {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface RealtimeStartOptions {
  model?: string;
  voice?: string;
  prompt?: string | null;
  version?: "v1" | "v2" | "v3";
  clientManagedHandoffs?: boolean;
  transport?: { type: "webrtc"; sdp: string };
}

export interface RealtimeAudioChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private turns = new Map<string, TurnTracker>();
  private activeByThread = new Map<string, string>();

  constructor(private readonly logger: Logger) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    const entrypoint = codexEntrypoint();
    if (!fs.existsSync(entrypoint)) throw new Error(`未找到固定版本 Codex 运行时: ${entrypoint}`);
    this.child = spawn(process.execPath, [
      entrypoint,
      "app-server",
      "--stdio",
      "--enable",
      "realtime_conversation",
    ], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CODEX_HOME: codexHome() },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.logger.debug(`codex: ${String(chunk).trim()}`));
    this.child.once("exit", (code, signal) => this.onExit(code, signal));
    this.child.once("error", (error) => this.onExit(null, String(error)));
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      clientInfo: { name: "weixin_codex_bridge", title: "Weixin Codex Bridge", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    child.kill();
  }

  async listThreads(limit = 8): Promise<CodexThread[]> {
    const result = await this.request<{ data: CodexThread[] }>("thread/list", {
      limit,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: true,
    });
    return result.data;
  }

  async searchThreads(searchTerm: string, limit = 5): Promise<ThreadSearchResult[]> {
    const [contentMatches, titleMatches] = await Promise.all([
      this.request<{ data: ThreadSearchResult[] }>("thread/search", {
        searchTerm,
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
      }).catch(() => ({ data: [] })),
      this.request<{ data: CodexThread[] }>("thread/list", {
        searchTerm,
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: true,
      }).catch(() => ({ data: [] })),
    ]);
    const merged = new Map<string, ThreadSearchResult>();
    for (const match of titleMatches.data) {
      merged.set(match.id, { thread: match, snippet: match.name ?? match.preview });
    }
    for (const match of contentMatches.data) merged.set(match.thread.id, match);
    if (merged.size < limit) {
      const localMatches = await searchLocalThreadIndex(searchTerm, limit * 2);
      const knownThreads = await this.listThreads(500).catch(() => []);
      const metadata = new Map(knownThreads.map((thread) => [thread.id, thread]));
      for (const match of localMatches) {
        if (merged.has(match.threadId)) continue;
        const thread = metadata.get(match.threadId) ?? await this.readThread(match.threadId).catch(() => undefined);
        if (!thread) continue;
        merged.set(match.threadId, { thread, snippet: match.snippet });
      }
    }
    return [...merged.values()]
      .sort((left, right) => right.thread.updatedAt - left.thread.updatedAt)
      .slice(0, limit);
  }

  async readThread(threadId: string): Promise<CodexThread> {
    const result = await this.request<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: false });
    return result.thread;
  }

  async readTurnResult(threadId: string, turnId: string): Promise<TurnResult | undefined> {
    const result = await this.request<{ thread: CodexThread & { turns?: Array<{
      id: string;
      status?: string;
      error?: { message?: string } | null;
      items?: Array<{ type?: string; text?: string }>;
    }> } }>("thread/read", { threadId, includeTurns: true });
    const turn = result.thread.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) return undefined;
    const text = [...(turn.items ?? [])]
      .reverse()
      .find((item) => item.type === "agentMessage" && item.text)?.text ?? "";
    return {
      threadId,
      turnId,
      status: turn.status ?? "unknown",
      text,
      error: turn.error?.message,
    };
  }

  async startThread(cwd: string, ephemeral = false): Promise<CodexThread> {
    if (!isProjectPathAllowed(cwd)) throw new Error(`项目目录不在 WEIXIN_CODEX_ALLOWED_ROOTS 允许范围内：${cwd}`);
    const result = await this.request<{ thread: CodexThread }>("thread/start", {
      cwd,
      approvalPolicy: "never",
      sandbox: safeModeEnabled() ? "workspace-write" : "danger-full-access",
      ephemeral,
    });
    return result.thread;
  }

  async resumeThread(threadId: string): Promise<CodexThread> {
    const metadata = await this.readThread(threadId);
    if (!isProjectPathAllowed(metadata.cwd)) {
      throw new Error(`任务目录不在 WEIXIN_CODEX_ALLOWED_ROOTS 允许范围内：${metadata.cwd}`);
    }
    if (
      metadata.cliVersion
      && compareCodexVersions(metadata.cliVersion, CODEX_VERSION) === 1
    ) {
      throw new Error(`任务版本为 ${metadata.cliVersion}，桥接运行时为 ${CODEX_VERSION}；请先升级桥接依赖`);
    }
    if (metadata.status.type === "active") {
      throw new Error("该任务当前正在另一个 Codex 客户端执行，请先停止桌面端任务");
    }
    const result = await this.request<{ thread: CodexThread }>("thread/resume", {
      threadId,
      approvalPolicy: "never",
      sandbox: safeModeEnabled() ? "workspace-write" : "danger-full-access",
      excludeTurns: true,
    });
    return result.thread;
  }

  async startTurn(threadId: string, text: string, clientMessageId: string, attachments: TurnAttachment[] = []): Promise<{ turnId: string; completion: Promise<TurnResult> }> {
    const fileNotes = attachments
      .filter((attachment) => attachment.kind === "file")
      .map((attachment) => `微信附件“${attachment.name}”已下载到本机：${attachment.path}`);
    const prompt = [text, ...fileNotes].filter(Boolean).join("\n\n");
    const input: Array<Record<string, unknown>> = [
      { type: "text", text: prompt, text_elements: [] },
      ...attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ type: "localImage", path: attachment.path })),
    ];
    const activeTurn = this.activeByThread.get(threadId);
    if (activeTurn) {
      await this.request("turn/steer", {
        threadId,
        expectedTurnId: activeTurn,
        clientUserMessageId: clientMessageId,
        input,
      });
      const tracker = this.turns.get(activeTurn);
      if (!tracker) throw new Error("活动任务状态已丢失");
      return { turnId: activeTurn, completion: tracker.completion };
    }

    const response = await this.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      clientUserMessageId: clientMessageId,
      input,
      approvalPolicy: "never",
      ...(safeModeEnabled() ? {} : { sandboxPolicy: { type: "dangerFullAccess" } }),
    });
    const turnId = response.turn.id;
    let resolve!: (value: TurnResult) => void;
    const completion = new Promise<TurnResult>((done) => { resolve = done; });
    const tracker: TurnTracker = { threadId, turnId, text: "", resolve, completion };
    this.turns.set(turnId, tracker);
    this.activeByThread.set(threadId, turnId);
    return { turnId, completion };
  }

  activeTurn(threadId: string): string | undefined {
    return this.activeByThread.get(threadId);
  }

  async interrupt(threadId: string): Promise<boolean> {
    const turnId = this.activeByThread.get(threadId);
    if (!turnId) return false;
    await this.request("turn/interrupt", { threadId, turnId });
    try {
      await this.request("thread/backgroundTerminals/clean", { threadId });
    } catch (error) {
      this.logger.warn(`后台终端清理失败: ${String(error)}`);
    }
    return true;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async startRealtime(threadId: string, options: RealtimeStartOptions, timeoutMs = 15_000): Promise<void> {
    await this.request("thread/realtime/start", {
      threadId,
      clientManagedHandoffs: options.clientManagedHandoffs ?? false,
      codexResponsesAsItems: false,
      outputModality: "audio",
      includeStartupContext: false,
      version: options.version ?? "v3",
      voice: options.voice,
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.model ? { model: options.model } : {}),
    }, timeoutMs);
  }

  async appendRealtimeText(threadId: string, text: string): Promise<void> {
    await this.request("thread/realtime/appendText", { threadId, text, role: "user" });
  }

  async appendRealtimeAudio(threadId: string, audio: RealtimeAudioChunk): Promise<void> {
    await this.request("thread/realtime/appendAudio", { threadId, audio });
  }

  async appendRealtimeSpeech(threadId: string, text: string): Promise<void> {
    await this.request("thread/realtime/appendSpeech", { threadId, text });
  }

  async stopRealtime(threadId: string, timeoutMs = 5_000): Promise<void> {
    await this.request("thread/realtime/stop", { threadId }, timeoutMs);
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32603, message } });
  }

  private async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.child) throw new Error("Codex app-server 尚未启动");
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (callback: () => void) => {
        if (timer) clearTimeout(timer);
        callback();
      };
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method} 在 ${timeoutMs}ms 内未响应`));
      }, timeoutMs);
      timer.unref();
    });
    this.write({ method, id, params });
    return await response as T;
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server 连接已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcResponse | CodexNotification;
    try {
      message = JSON.parse(line) as RpcResponse | CodexNotification;
    } catch {
      this.logger.warn(`无法解析 Codex 消息: ${line.slice(0, 200)}`);
      return;
    }
    if ("method" in message) {
      if (message.id !== undefined) {
        this.emit("serverRequest", { id: message.id, method: message.method, params: message.params ?? {} } satisfies ServerRequestEvent);
      } else {
        this.onNotification(message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  private onNotification(event: CodexNotification): void {
    const params = event.params ?? {};
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof (params.turn as { id?: unknown } | undefined)?.id === "string"
        ? (params.turn as { id: string }).id
        : undefined;
    if (event.method === "item/agentMessage/delta" && turnId) {
      const tracker = this.turns.get(turnId);
      if (tracker && typeof params.delta === "string") tracker.text += params.delta;
    } else if (event.method === "item/completed" && turnId) {
      const tracker = this.turns.get(turnId);
      const item = params.item as { type?: string; text?: string } | undefined;
      if (tracker && !tracker.text && item?.type === "agentMessage" && item.text) tracker.text = item.text;
    } else if (event.method === "turn/completed" && turnId) {
      const tracker = this.turns.get(turnId);
      if (!tracker) return;
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
      this.turns.delete(turnId);
      this.activeByThread.delete(tracker.threadId);
      tracker.resolve({
        threadId: tracker.threadId,
        turnId,
        status: turn?.status ?? "completed",
        text: tracker.text,
        error: turn?.error?.message,
      });
    }
    this.emit("notification", event);
  }

  private onExit(code: number | null, signal: string | null): void {
    if (!this.child && this.pending.size === 0) return;
    this.child = undefined;
    const error = new Error(`Codex app-server 已退出 (code=${code}, signal=${signal ?? "none"})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const tracker of this.turns.values()) {
      tracker.resolve({ threadId: tracker.threadId, turnId: tracker.turnId, status: "failed", text: tracker.text, error: error.message });
    }
    this.turns.clear();
    this.activeByThread.clear();
    this.emit("exit", error);
  }
}

export function compareCodexVersions(left: string, right: string): -1 | 0 | 1 | undefined {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return undefined;

  for (let index = 0; index < 3; index += 1) {
    const comparison = Math.sign(leftVersion.main[index] - rightVersion.main[index]);
    if (comparison) return comparison as -1 | 1;
  }
  if (!leftVersion.prerelease.length && !rightVersion.prerelease.length) return 0;
  if (!leftVersion.prerelease.length) return 1;
  if (!rightVersion.prerelease.length) return -1;

  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function parseVersion(value: string): { main: [number, number, number]; prerelease: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return undefined;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}
