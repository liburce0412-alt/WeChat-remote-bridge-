import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /("?(?:bot_token|token|context_token|typing_ticket|aes_key)"?\s*[:=]\s*"?)[^",\s}]+/gi,
];

function redact(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "$1***"), value);
}

export class Logger {
  constructor(
    private readonly logFile?: string,
    private readonly minimum: LogLevel = "info",
  ) {}

  debug(message: string): void {
    this.write("debug", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  private write(level: LogLevel, message: string): void {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(this.minimum)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}`;
    const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    target(line);
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 5 * 1024 * 1024) {
        fs.rmSync(`${this.logFile}.1`, { force: true });
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
      fs.appendFileSync(this.logFile, `${line}\n`, "utf8");
    } catch {
      // Logging must never stop the bridge.
    }
  }
}
