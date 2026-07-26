import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { Logger } from "./logger.js";
import { findWhisperModel, transcriberScript } from "./paths.js";

interface PendingTranscription {
  resolve: (value: { text: string; confidence: number }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class Transcriber {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private ready?: Promise<void>;
  private pending = new Map<number, PendingTranscription>();

  constructor(private readonly logger: Logger) {}

  async start(): Promise<void> {
    if (this.child) return await this.ready;
    const model = findWhisperModel();
    if (!model) throw new Error("未找到本地 faster-whisper 模型");
    this.child = spawn("py", ["-3", "-u", transcriberScript(), "--model", model, "--compute-type", "int8_float16"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.logger.debug(`whisper: ${String(chunk).trim()}`));
    const lines = readline.createInterface({ input: this.child.stdout });
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { ready?: boolean; id?: number; text?: string; confidence?: number; error?: string };
        if (message.ready) {
          markReady();
          return;
        }
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve({ text: message.text ?? "", confidence: message.confidence ?? 0 });
      } catch (error) {
        this.logger.warn(`无法解析语音转写结果: ${String(error)}`);
      }
    });
    this.child.once("error", failReady);
    this.child.once("exit", (code) => {
      const error = new Error(`语音转写进程已退出 (${code})`);
      failReady(error);
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
    });
    await this.ready;
    this.logger.info(`本地语音模型已加载: ${model}`);
  }

  async transcribe(file: string): Promise<{ text: string; confidence: number }> {
    await this.start();
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("语音转写超过 120 秒"));
      }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, path: file })}\n`);
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
