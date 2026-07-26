import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { codexHome, threadSearchIndexFile } from "../paths.js";

export interface LocalThreadMatch {
  threadId: string;
  snippet: string;
  updatedAt: number;
}

interface CachedRollout {
  threadId: string;
  size: number;
  mtimeMs: number;
  updatedAt: number;
  text: string;
}

interface IndexFile {
  version: 1;
  entries: Record<string, CachedRollout>;
}

interface MutableMatch extends LocalThreadMatch {
  score: number;
}

const DEFAULT_BUDGET_MS = 1_500;
const MAX_TEXT_PER_ROLLOUT = 256 * 1024;
const MAX_ROLLOUT_SCAN_BYTES = 16 * 1024 * 1024;
let loadedIndexPath: string | undefined;
let loadedIndex: IndexFile | undefined;
let saveChain = Promise.resolve();

export async function searchLocalThreadIndex(
  term: string,
  limit = 5,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<LocalThreadMatch[]> {
  const needle = term.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches = new Map<string, MutableMatch>();
  readTitleIndex(needle, matches);

  const index = loadIndex();
  const files = listRollouts()
    .map((file) => ({ file, stat: safeStat(file) }))
    .filter((entry): entry is { file: string; stat: fs.Stats } => Boolean(entry.stat))
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const livePaths = new Set(files.map(({ file }) => file));
  let changed = false;
  for (const file of Object.keys(index.entries)) {
    if (!livePaths.has(file)) {
      delete index.entries[file];
      changed = true;
    }
  }

  for (const entry of Object.values(index.entries)) matchCached(entry, needle, matches);

  const deadline = Date.now() + Math.max(50, budgetMs);
  for (const { file, stat } of files) {
    const cached = index.entries[file];
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue;
    if (Date.now() >= deadline) break;
    const scanned = await scanRollout(file, stat, deadline);
    if (!scanned) break;
    index.entries[file] = scanned;
    matchCached(scanned, needle, matches);
    changed = true;
  }
  if (changed) queueIndexSave(index);

  return [...matches.values()]
    .sort((left, right) => right.score - left.score || right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map(({ threadId, snippet, updatedAt }) => ({ threadId, snippet, updatedAt }));
}

function loadIndex(): IndexFile {
  const file = threadSearchIndexFile();
  if (loadedIndex && loadedIndexPath === file) return loadedIndex;
  loadedIndexPath = file;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IndexFile>;
    loadedIndex = parsed.version === 1 && parsed.entries && typeof parsed.entries === "object"
      ? { version: 1, entries: parsed.entries }
      : { version: 1, entries: {} };
  } catch {
    loadedIndex = { version: 1, entries: {} };
  }
  return loadedIndex;
}

function queueIndexSave(index: IndexFile): void {
  const file = threadSearchIndexFile();
  const snapshot = JSON.stringify(index);
  saveChain = saveChain.catch(() => undefined).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, snapshot, "utf8");
    await fs.promises.rename(temporary, file);
  });
}

function readTitleIndex(needle: string, matches: Map<string, MutableMatch>): void {
  const file = path.join(codexHome(), "session_index.jsonl");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      const title = record.thread_name ?? "";
      if (!record.id || !title.toLocaleLowerCase().includes(needle)) continue;
      matches.set(record.id, {
        threadId: record.id,
        snippet: title,
        updatedAt: Date.parse(record.updated_at ?? "") || 0,
        score: 100,
      });
    } catch {
      // Ignore a partially written index line.
    }
  }
}

async function scanRollout(file: string, stat: fs.Stats, deadline: number): Promise<CachedRollout | undefined> {
  const threadId = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  if (!threadId) return undefined;
  const parts: string[] = [];
  let length = 0;
  const start = Math.max(0, stat.size - MAX_ROLLOUT_SCAN_BYTES);
  let firstLine = start > 0;
  const input = fs.createReadStream(file, { encoding: "utf8", start });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (firstLine) {
        firstLine = false;
        continue;
      }
      if (Date.now() >= deadline) {
        input.destroy();
        return undefined;
      }
      try {
        const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
        if (!record.payload || !isConversationRecord(record.type, record.payload)) continue;
        const text = extractConversationText(record.payload).replace(/\s+/g, " ").trim();
        if (!text) continue;
        const remaining = MAX_TEXT_PER_ROLLOUT - length;
        if (remaining <= 0) break;
        const part = text.slice(0, remaining);
        parts.push(part);
        length += part.length + 1;
      } catch {
        // Ignore a partially written rollout line.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    threadId,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: stat.mtimeMs,
    text: parts.join("\n"),
  };
}

function matchCached(entry: CachedRollout, needle: string, matches: Map<string, MutableMatch>): void {
  const offset = entry.text.toLocaleLowerCase().indexOf(needle);
  if (offset < 0) return;
  const existing = matches.get(entry.threadId);
  if (existing?.score && existing.score >= 50) return;
  matches.set(entry.threadId, {
    threadId: entry.threadId,
    snippet: snippetAround(entry.text, offset, needle.length),
    updatedAt: entry.updatedAt,
    score: 50,
  });
}

function isConversationRecord(type: string | undefined, payload: Record<string, unknown>): boolean {
  if (type === "response_item") return payload.role === "user" || payload.role === "assistant";
  if (type !== "event_msg") return false;
  return payload.type === "user_message" || payload.type === "agent_message";
}

function extractConversationText(payload: Record<string, unknown>): string {
  if (typeof payload.message === "string") return payload.message;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .map((item) => {
      const part = item as { text?: unknown; input_text?: unknown; output_text?: unknown };
      return [part.text, part.input_text, part.output_text].find((value): value is string => typeof value === "string") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function snippetAround(text: string, offset: number, needleLength: number): string {
  const start = Math.max(0, offset - 50);
  const end = Math.min(text.length, offset + needleLength + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function listRollouts(): string[] {
  const files: string[] = [];
  for (const root of [path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")]) {
    if (!fs.existsSync(root)) continue;
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(fullPath);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
      }
    }
  }
  return files;
}

function safeStat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}
