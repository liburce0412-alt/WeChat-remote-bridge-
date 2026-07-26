import type { WeixinMessage } from "./weixin/types.js";

export interface WeixinCredentials {
  botToken: string;
  botId: string;
  baseUrl: string;
  allowedUserId: string;
}

export interface SelectionCandidate {
  kind: "thread" | "project";
  id: string;
  label: string;
  cwd: string;
}

export interface TurnAttachment {
  path: string;
  kind: "image" | "file";
  name: string;
}

export interface PendingSelection {
  originalText?: string;
  attachments?: TurnAttachment[];
  voiceReply?: boolean;
  candidates: SelectionCandidate[];
}

export interface InboxEntry {
  key: string;
  message: WeixinMessage;
  status: "received" | "dispatched";
}

export interface ActiveTurnState {
  threadId: string;
  turnId: string;
  sourceMessageKey: string;
  startedAt: number;
  replyTo?: string;
  contextToken?: string;
  phase?: string;
  recentOperation?: string;
  lastProgressAt?: number;
  voiceReply?: boolean;
}

export interface PendingUserInputState {
  questions: Array<{
    id: string;
    question: string;
    options?: Array<{ label: string; description?: string }> | null;
  }>;
  receivedAt: number;
}

interface OutboxBase {
  id: string;
  to: string;
  contextToken?: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface TextOutboxEntry extends OutboxBase {
  kind: "text";
  text: string;
}

export interface FileOutboxEntry extends OutboxBase {
  kind: "file";
  path: string;
  name: string;
  mediaKind: "file" | "audio";
  managed?: boolean;
}

export interface SpeechOutboxEntry extends OutboxBase {
  kind: "speech";
  threadId: string;
  text: string;
  fallbackText: string;
  name: string;
}

export type OutboxEntry = TextOutboxEntry | FileOutboxEntry | SpeechOutboxEntry;

export interface BridgeState {
  version: 1;
  credentials?: WeixinCredentials;
  syncBuf: string;
  contextToken?: string;
  boundThreadId?: string;
  voiceModeEnabled: boolean;
  awaitingNewTaskRequest?: boolean;
  pendingSelection?: PendingSelection;
  inbox: InboxEntry[];
  processedIds: string[];
  activeTurn?: ActiveTurnState;
  pendingUserInput?: PendingUserInputState;
  outbox: OutboxEntry[];
}

export const EMPTY_STATE: BridgeState = {
  version: 1,
  syncBuf: "",
  voiceModeEnabled: false,
  inbox: [],
  processedIds: [],
  outbox: [],
};

export interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  cliVersion: string;
  updatedAt: number;
  status: { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: unknown[] };
}

export interface ThreadSearchResult {
  thread: CodexThread;
  snippet: string;
}

export interface TurnResult {
  threadId: string;
  turnId: string;
  status: string;
  text: string;
  error?: string;
}
