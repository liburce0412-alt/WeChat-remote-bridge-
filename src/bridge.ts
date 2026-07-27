import fs from "node:fs";
import path from "node:path";
import { assertSafeToResumeThread, inspectThreadActivity, staleOpenTurnIds } from "./codex/activity.js";
import { CodexClient, type CodexNotification, type ServerRequestEvent } from "./codex/client.js";
import {
  RealtimeManager,
  type RealtimeFailure,
} from "./codex/realtime.js";
import { parseCommand } from "./commands.js";
import { DeliveryQueue } from "./delivery.js";
import { Logger } from "./logger.js";
import { heartbeatFile, isProjectPathAllowed, safeModeEnabled } from "./paths.js";
import { describeProgress } from "./progress.js";
import { StateStore } from "./state.js";
import { Transcriber } from "./transcription.js";
import type {
  BridgeState,
  InboxEntry,
  PendingUserInputState,
  SelectionCandidate,
  TurnAttachment,
  TurnResult,
} from "./types.js";
import { WeixinClient } from "./weixin/client.js";
import { loginWeixinInBackground } from "./weixin/login.js";
import { downloadAttachment, downloadVoicePcm, writeTemporaryPcmWav } from "./weixin/media.js";
import { MessageItemType, type WeixinMessage } from "./weixin/types.js";
import { disableBridgeService } from "./windows-service.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const HELP = [
  "微信 Codex Bridge 指令：",
  "继续 <任务名称或历史内容> — 查找并续接桌面任务",
  "新任务 <需求> — 选择项目后创建任务",
  "最近 — 查看最近任务",
  "下一页 / 上一页 — 浏览任务候选列表",
  "当前 — 查看当前绑定和运行状态",
  "停止 — 中断当前任务并清理后台终端",
  "取消绑定 — 退出当前任务",
  "语音模式 — Codex 处理消息，中间进度发文字，最终结果由 GPT-Live 生成一条音频附件",
  "退出语音 — 恢复全部文字回复并释放语音会话",
  "结束语音会话 — 仅释放当前语音会话",
  "语音状态 — 查看语音模式和连接状态",
  "关闭服务 — 关闭 Bridge 和自动守护（需在电脑重新开启）",
  "帮助 — 显示本说明",
].join("\n");

interface PendingUserInput extends PendingUserInputState {
  requestId?: number | string;
}

interface ExtractedInput {
  text: string;
  attachments: TurnAttachment[];
  voicePcm?: Buffer;
}

export class Bridge {
  private state!: BridgeState;
  private readonly codex: CodexClient;
  private readonly realtime: RealtimeManager;
  private readonly transcriber: Transcriber;
  private readonly delivery: DeliveryQueue;
  private weixin!: WeixinClient;
  private pendingUserInput?: PendingUserInput;
  private loadedThreads = new Set<string>();
  private controller = new AbortController();
  private heartbeatTimer?: NodeJS.Timeout;
  private lastProgressAt = 0;
  private lastProgressText?: string;
  private realtimeSpeechSuppressed = new Set<string>();

  constructor(
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    this.codex = new CodexClient(logger);
    this.realtime = new RealtimeManager(this.codex, logger);
    this.transcriber = new Transcriber(logger);
    this.delivery = new DeliveryQueue(
      () => this.state,
      () => this.weixin,
      store,
      this.realtime,
      logger,
      (threadId) => this.realtimeSpeechSuppressed.add(threadId),
    );
    this.codex.on("serverRequest", (request: ServerRequestEvent) => {
      void this.handleServerRequest(request).catch((error) => {
        this.logger.error(`Codex 服务端请求处理失败: ${String(error)}`);
        this.codex.respondError(request.id, "Bridge 处理请求失败");
      });
    });
    this.codex.on("notification", (event: CodexNotification) => {
      void this.handleNotification(event).catch((error) => {
        this.logger.error(`Codex 通知处理失败: ${String(error)}`);
      });
    });
    this.codex.on("exit", (error: Error) => {
      this.loadedThreads.clear();
      this.logger.error(`${error.message}；Bridge 将退出并由 watchdog 重启`);
      this.controller.abort();
    });
    this.realtime.on("failure", (failure: RealtimeFailure) => {
      this.logger.warn(`GPT-Live 会话故障: ${failure.message}`);
    });
    this.realtime.on("closed", (event: { threadId: string; reason?: string }) => {
      this.logger.debug(`GPT-Live 会话已关闭：${event.threadId}${event.reason ? `（${event.reason}）` : ""}`);
    });
  }

  async run(): Promise<void> {
    this.state = await this.store.load();
    if (this.state.pendingUserInput) this.pendingUserInput = { ...this.state.pendingUserInput };
    const credentials = this.state.credentials;
    if (!credentials) throw new Error("尚未配置微信，请先运行 weixin-codex setup");
    this.weixin = new WeixinClient(credentials.baseUrl, credentials.botToken, this.logger);
    await this.codex.start();
    this.startHeartbeat();
    await this.weixin.notifyStart().catch((error) => this.logger.warn(`微信启动通知失败: ${String(error)}`));
    this.logger.info(`Bridge 已启动，绑定用户 ${mask(credentials.allowedUserId)}`);
    await this.delivery.flush();
    await this.recoverInterruptedTurn();
    await this.recoverDispatchedMessages();
    await this.monitor();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.delivery.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.updateHeartbeat("stopping");
    await this.weixin?.notifyStop().catch(() => undefined);
    this.transcriber.stop();
    await this.realtime.dispose();
    await this.codex.stop();
  }

  private async monitor(): Promise<void> {
    let timeout = 35_000;
    let failures = 0;
    let failureStartedAt = 0;
    while (!this.controller.signal.aborted) {
      try {
        const response = await this.weixin.getUpdates(this.state.syncBuf, timeout, this.controller.signal);
        if (this.controller.signal.aborted) break;
        timeout = response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0
          ? response.longpolling_timeout_ms
          : timeout;
        if ((response.ret && response.ret !== 0) || (response.errcode && response.errcode !== 0)) {
          if (response.ret === -14 || response.errcode === -14) {
            await this.recoverWeixinCredentials();
            continue;
          }
          throw new Error(`getUpdates ret=${response.ret} errcode=${response.errcode}: ${response.errmsg ?? "unknown"}`);
        }
        if (failures > 0) {
          this.logger.info(`微信长轮询已恢复（中断 ${formatDuration(Date.now() - failureStartedAt)}，失败 ${failures} 次）`);
        }
        failures = 0;
        failureStartedAt = 0;
        this.persistIncoming(response.msgs ?? [], response.get_updates_buf);
        await this.store.save(this.state);
        await this.drainInbox();
        this.updateHeartbeat("running");
      } catch (error) {
        if (this.controller.signal.aborted) break;
        failures += 1;
        failureStartedAt ||= Date.now();
        if (failures <= 3 || failures % 10 === 0 || (failures & (failures - 1)) === 0) {
          this.logger.warn(`微信长轮询失败（连续 ${failures} 次）: ${String(error)}`);
        }
        const baseDelay = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(failures - 1, 8)));
        const jitter = Math.floor(baseDelay * (0.85 + Math.random() * 0.3));
        this.updateHeartbeat("network-backoff");
        await sleep(jitter, this.controller.signal);
      }
    }
  }

  private async recoverWeixinCredentials(): Promise<void> {
    const previous = this.state.credentials!;
    this.logger.warn("微信凭据失效，正在生成新的扫码登录二维码");
    const credentials = await loginWeixinInBackground(this.logger, previous.botToken);
    if (credentials.allowedUserId !== previous.allowedUserId) {
      throw new Error("重新扫码的微信用户与首次绑定用户不一致，已拒绝替换凭据");
    }
    this.state.credentials = credentials;
    this.state.syncBuf = "";
    await this.store.save(this.state);
    this.weixin = new WeixinClient(credentials.baseUrl, credentials.botToken, this.logger);
    await this.weixin.notifyStart().catch(() => undefined);
    await this.queueText(credentials.allowedUserId, "微信凭据已自动更新，Bridge 已恢复在线。", this.state.contextToken);
  }

  private persistIncoming(messages: WeixinMessage[], syncBuf?: string): void {
    if (syncBuf) this.state.syncBuf = syncBuf;
    const allowedUser = this.state.credentials!.allowedUserId;
    for (const message of messages) {
      if (message.group_id || message.from_user_id !== allowedUser || message.message_type !== 1) continue;
      const key = messageKey(message);
      if (this.state.processedIds.includes(key) || this.state.inbox.some((item) => item.key === key)) continue;
      this.state.inbox.push({ key, message, status: "received" });
    }
  }

  private async drainInbox(): Promise<void> {
    for (const entry of [...this.state.inbox]) {
      if (entry.status === "dispatched") continue;
      try {
        if (entry.message.context_token) this.state.contextToken = entry.message.context_token;
        const input = await this.extractInput(entry.message);
        if (!input.text && !input.attachments.length && !input.voicePcm?.length) {
          await this.reply("没有识别到可处理的文字、语音、图片或文件。", entry.message);
        } else {
          const routeText = input.text.trim() || (input.attachments.length ? "请查看并处理微信附件。" : "");
          await this.route(routeText, entry, input.attachments, input.voicePcm);
        }
      } catch (error) {
        this.logger.error(`消息处理失败 ${entry.key}: ${String(error)}`);
        await this.reply(`处理失败：${error instanceof Error ? error.message : String(error)}`, entry.message).catch(() => undefined);
      }
      this.finishInbox(entry.key);
      await this.store.save(this.state);
    }
  }

  private async extractInput(message: WeixinMessage): Promise<ExtractedInput> {
    let text = "";
    const attachments: TurnAttachment[] = [];
    const voiceChunks: Buffer[] = [];
    for (const item of message.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text = [text, item.text_item.text].filter(Boolean).join("\n");
        continue;
      }
      if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
        const file = await downloadAttachment(item.image_item.media, CDN_BASE_URL, {
          aesKey: item.image_item.aeskey,
          image: true,
        });
        attachments.push({ path: file, kind: "image", name: path.basename(file) });
        continue;
      }
      if (item.type === MessageItemType.FILE && item.file_item?.media) {
        const name = item.file_item.file_name ?? "attachment.bin";
        const file = await downloadAttachment(item.file_item.media, CDN_BASE_URL, { fileName: name });
        attachments.push({ path: file, kind: "file", name });
        continue;
      }
      if (item.type === MessageItemType.VOICE && item.voice_item) {
        const transcript = item.voice_item.text?.trim();
        if (transcript) {
          this.logger.info("微信语音使用已有转写");
          text = [text, transcript].filter(Boolean).join("\n");
          continue;
        }
        if (!item.voice_item.media) {
          throw new Error("语音消息没有可下载的媒体内容或转写");
        }
        if (voiceChunks.length) voiceChunks.push(Buffer.alloc(24_000 * 2 * 300 / 1_000));
        const pcm = await downloadVoicePcm(item.voice_item.media, CDN_BASE_URL);
        this.logger.info(`微信语音无转写，已解码 ${Math.round(pcm.length * 1_000 / (24_000 * 2))}ms PCM`);
        voiceChunks.push(pcm);
      }
    }
    return {
      text,
      attachments,
      voicePcm: voiceChunks.length ? Buffer.concat(voiceChunks) : undefined,
    };
  }

  private async route(
    initialText: string,
    entry: InboxEntry,
    attachments: TurnAttachment[] = [],
    initialVoicePcm?: Buffer,
  ): Promise<void> {
    let text = initialText;
    if (initialVoicePcm) {
      const transcript = await this.transcribePcmFallback(initialVoicePcm, entry.message);
      if (!transcript) return;
      text = [text, transcript].filter(Boolean).join("\n");
    }
    const command = parseCommand(text);
    if (command?.type === "help") return await this.reply(HELP, entry.message);
    if (command?.type === "current") return await this.showCurrent(entry.message);
    if (command?.type === "recent") return await this.showRecent(undefined, entry.message);
    if (command?.type === "voiceOn") {
      this.state.voiceModeEnabled = true;
      await this.store.save(this.state);
      return await this.reply("语音模式已开启：文字和语音仍由 Codex 处理，中间进度只发文字，最终结果由 GPT-Live 返回一条音频附件。", entry.message);
    }
    if (command?.type === "voiceOff") {
      this.state.voiceModeEnabled = false;
      if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.store.save(this.state);
      await this.realtime.stop("voice-mode-off");
      return await this.reply("已退出语音模式并释放当前 GPT-Live 会话。接下来无论发送文字还是语音，都会使用 Codex 文字回答。", entry.message);
    }
    if (command?.type === "voiceStop") {
      if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.realtime.stop("user-request");
      return await this.reply("当前 GPT-Live 会话已释放；语音模式开关保持不变。", entry.message);
    }
    if (command?.type === "voiceStatus") return await this.showVoiceStatus(entry.message);
    if (command?.type === "switchTask") {
      if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.realtime.stop("task-switch");
      this.state.boundThreadId = undefined;
      this.state.awaitingNewTaskRequest = undefined;
      this.state.pendingSelection = undefined;
      await this.store.save(this.state);
      return await this.showRecent(undefined, entry.message);
    }
    if (command?.type === "stop") return await this.stopCurrent(entry.message);
    if (command?.type === "unbind") {
      if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.realtime.stop("task-unbind");
      this.state.boundThreadId = undefined;
      this.state.awaitingNewTaskRequest = undefined;
      this.state.pendingSelection = undefined;
      await this.store.save(this.state);
      return await this.reply("已取消当前任务绑定。", entry.message);
    }
    if (command?.type === "shutdown") {
      await this.reply("Bridge 服务即将关闭，watchdog 也会停用。重新开启需在电脑运行：node dist/cli.js start-service", entry.message);
      await this.realtime.stop("bridge-shutdown");
      await disableBridgeService();
      this.controller.abort();
      return;
    }
    if (command?.type === "continue") {
      return await this.searchAndSelect(command.term, undefined, entry.message);
    }
    if (command?.type === "newTask") {
      if (command.request) {
        if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
        await this.realtime.stop("new-task");
        this.state.awaitingNewTaskRequest = undefined;
        return await this.selectProject(command.request, entry.message, attachments, this.state.voiceModeEnabled);
      }
      if (this.state.boundThreadId) this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.realtime.stop("new-task");
      this.state.boundThreadId = undefined;
      this.state.pendingSelection = undefined;
      this.state.awaitingNewTaskRequest = true;
      await this.store.save(this.state);
      return await this.reply("已切换到新建任务模式。请发送新任务的完整需求。", entry.message);
    }
    if (!this.state.boundThreadId && text.trim() === "继续") {
      return await this.showRecent(text, entry.message, attachments, this.state.voiceModeEnabled);
    }
    if (this.state.pendingSelection) {
      const pending = this.state.pendingSelection;
      const currentPage = clampSelectionPage(pending.candidates, pending.page ?? 0);
      if (isNextPage(text) || isPreviousPage(text)) {
        const direction = isNextPage(text) ? 1 : -1;
        const nextPage = clampSelectionPage(pending.candidates, currentPage + direction);
        pending.page = nextPage;
        await this.store.save(this.state);
        const boundary = nextPage === currentPage
          ? (direction > 0 ? "已经是最后一页。" : "已经是第一页。")
          : undefined;
        await this.reply(
          [boundary, formatCandidates(pending.candidates, nextPage)].filter(Boolean).join("\n"),
          entry.message,
        );
        return;
      }
      const index = findCandidateIndex(pending.candidates, text, currentPage);
      if (index < 0) {
        await this.reply(
          `没有找到“${text}”。请回复当前页序号、任务名称，或“下一页/上一页”。`,
          entry.message,
        );
        return;
      }
      await this.selectCandidate(index + 1, entry);
      return;
    }
    if (this.pendingUserInput) {
      await this.answerUserInput(text, entry);
      return;
    }
    if (this.state.awaitingNewTaskRequest) {
      this.state.awaitingNewTaskRequest = undefined;
      await this.selectProject(text, entry.message, attachments, this.state.voiceModeEnabled);
      return;
    }
    if (!this.state.boundThreadId) {
      await this.showRecent(text, entry.message, attachments, this.state.voiceModeEnabled);
      return;
    }
    await this.dispatchPrompt(
      this.state.boundThreadId,
      text,
      entry,
      attachments,
      this.state.voiceModeEnabled,
    );
  }

  private async showVoiceStatus(message: WeixinMessage): Promise<void> {
    const status = this.realtime.getStatus();
    const connection = status.active
      ? "已连接"
      : status.connecting
        ? "正在连接"
        : "未连接";
    await this.reply([
      `语音模式：${this.state.voiceModeEnabled ? "已开启（文字和语音返回音频附件）" : "默认（文字和语音均返回文字）"}`,
      `GPT-Live：${connection}`,
      `会话任务：${status.threadId ?? "无"}`,
      `任务保活：${status.taskActive ? "Codex 正在执行，不会空闲释放" : "未检测到活动任务"}`,
      `模型：${status.model}`,
      `声音：${status.voice}`,
      `传输：${status.transport === "webrtc" ? "WebRTC（ChatGPT 登录态）" : "WebSocket"}`,
      `Handoff：${status.clientManagedHandoffs ? "Bridge 主动朗读" : "Codex 自动播报"}`,
      `协议：${status.version.toUpperCase()}`,
    ].join("\n"), message);
  }

  private async transcribePcmFallback(pcm: Buffer, message: WeixinMessage): Promise<string | undefined> {
    await this.reply("正在使用本地模型识别语音，以生成文字回答……", message);
    const wav = writeTemporaryPcmWav(pcm, 24_000);
    try {
      const result = await this.transcriber.transcribe(wav);
      if (!result.text || result.confidence < 0.30) {
        await this.reply("语音识别置信度过低，没有执行。请重新说一遍或改发文字。", message);
        return undefined;
      }
      await this.reply(`已识别：${result.text}`, message);
      return result.text;
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  private async showRecent(originalText: string | undefined, message: WeixinMessage, attachments: TurnAttachment[] = [], voiceReply = false): Promise<void> {
    const threads = await this.codex.listAllThreads();
    const candidates: SelectionCandidate[] = threads.map((thread) => ({
      kind: "thread",
      id: thread.id,
      label: thread.name ?? (thread.preview || thread.id),
      cwd: thread.cwd,
    }));
    const seen = new Set<string>();
    for (const thread of threads) {
      if (!thread.cwd || seen.has(thread.cwd)) continue;
      seen.add(thread.cwd);
      candidates.push({ kind: "project", id: thread.cwd, label: path.basename(thread.cwd), cwd: thread.cwd });
    }
    if (!candidates.length) {
      await this.reply("没有找到可用的桌面任务或项目。", message);
      return;
    }
    this.state.pendingSelection = { originalText, attachments, voiceReply, page: 0, candidates };
    await this.store.save(this.state);
    await this.reply(formatCandidates(candidates, 0), message);
  }

  private async searchAndSelect(term: string, originalText: string | undefined, message: WeixinMessage): Promise<void> {
    if (!term) {
      await this.reply("请使用：继续 <任务名称或历史内容>", message);
      return;
    }
    const results = await this.codex.searchThreads(term, 5);
    const candidates: SelectionCandidate[] = results.map(({ thread }) => ({
      kind: "thread",
      id: thread.id,
      label: thread.name ?? (thread.preview || thread.id),
      cwd: thread.cwd,
    }));
    if (!candidates.length) {
      await this.reply(`没有找到包含“${term}”的任务。`, message);
      return;
    }
    this.state.pendingSelection = { originalText, candidates };
    await this.store.save(this.state);
    await this.reply(formatCandidates(candidates), message);
  }

  private async selectProject(originalText: string, message: WeixinMessage, attachments: TurnAttachment[] = [], voiceReply = false): Promise<void> {
    if (!originalText) {
      await this.reply("请使用：新任务 <需求>", message);
      return;
    }
    const threads = await this.codex.listThreads(30);
    const seen = new Set<string>();
    const candidates: SelectionCandidate[] = [];
    for (const thread of threads) {
      if (!thread.cwd || seen.has(thread.cwd)) continue;
      seen.add(thread.cwd);
      candidates.push({ kind: "project", id: thread.cwd, label: path.basename(thread.cwd), cwd: thread.cwd });
      if (candidates.length >= 8) break;
    }
    if (!candidates.length) {
      await this.reply("最近任务中没有可用的项目目录。", message);
      return;
    }
    this.state.pendingSelection = { originalText, attachments, voiceReply, candidates };
    await this.store.save(this.state);
    await this.reply(formatCandidates(candidates), message);
  }

  private async selectCandidate(index: number, entry: InboxEntry): Promise<void> {
    const pending = this.state.pendingSelection;
    const candidate = pending?.candidates[index - 1];
    if (!pending || !candidate) {
      await this.reply("没有找到这个任务，请重新选择。", entry.message);
      return;
    }
    if (!isProjectPathAllowed(candidate.cwd)) {
      throw new Error(`项目目录不在 WEIXIN_CODEX_ALLOWED_ROOTS 允许范围内：${candidate.cwd}`);
    }
    if (this.state.boundThreadId && this.state.boundThreadId !== candidate.id) {
      this.realtimeSpeechSuppressed.add(this.state.boundThreadId);
      await this.realtime.stop("task-selected");
    }
    let threadId: string;
    if (candidate.kind === "thread") {
      assertSafeToResumeThread(candidate.id);
      const thread = await this.codex.resumeThread(candidate.id);
      this.loadedThreads.add(thread.id);
      threadId = thread.id;
      await this.reply(`已续接任务：${candidate.label}`, entry.message);
    } else {
      const thread = await this.codex.startThread(candidate.cwd);
      this.loadedThreads.add(thread.id);
      threadId = thread.id;
      await this.reply(`已在项目 ${candidate.label} 创建新任务。`, entry.message);
    }
    this.state.boundThreadId = threadId;
    this.state.pendingSelection = undefined;
    await this.store.save(this.state);
    if (pending.originalText) await this.dispatchPrompt(threadId, pending.originalText, entry, pending.attachments ?? [], pending.voiceReply ?? false);
  }

  private async dispatchPrompt(threadId: string, text: string, entry: InboxEntry, attachments: TurnAttachment[] = [], voiceReply = false): Promise<void> {
    const active = this.codex.activeTurn(threadId);
    let ignoredStaleTurns: string[] = [];
    if (!active) {
      const metadata = await this.codex.readThread(threadId);
      if (metadata.status.type === "active") {
        throw new Error("Codex 状态数据库显示该任务正在其他进程执行，Bridge 已拒绝接管");
      }
      const activity = inspectThreadActivity(threadId);
      ignoredStaleTurns = staleOpenTurnIds(activity);
      if (activity?.latestTurnOpen && ignoredStaleTurns.length === 0) {
        throw new Error("检测到桌面端或另一个 Codex 进程正在执行该任务，Bridge 已拒绝并发接管。请先停止桌面任务，或发送“换个任务”");
      }
      if (!this.loadedThreads.has(threadId)) {
        assertSafeToResumeThread(threadId);
        const thread = await this.codex.resumeThread(threadId);
        this.loadedThreads.add(thread.id);
      }
    }
    if (voiceReply) this.realtimeSpeechSuppressed.delete(threadId);
    entry.status = "dispatched";
    await this.store.save(this.state);
    await this.weixin.setTyping(entry.message.from_user_id!, entry.message.context_token ?? this.state.contextToken, true);
    const turn = await this.codex.startTurn(threadId, text, entry.key, attachments);
    if (!active) {
      this.state.activeTurn = {
        threadId,
        turnId: turn.turnId,
        sourceMessageKey: entry.key,
        startedAt: Date.now(),
        replyTo: entry.message.from_user_id,
        contextToken: entry.message.context_token ?? this.state.contextToken,
        phase: "已提交，等待 Codex 开始处理",
        recentOperation: "接收微信指令",
        lastProgressAt: Date.now(),
        voiceReply,
      };
      this.lastProgressAt = Date.now();
      this.lastProgressText = undefined;
      await this.store.save(this.state);
      void this.watchForConcurrentTurn(threadId, turn.turnId, new Set(ignoredStaleTurns));
    }
    if (active && voiceReply && this.state.activeTurn) {
      this.state.activeTurn.voiceReply = true;
      await this.store.save(this.state);
    }
    if (active) await this.reply("已补充到正在执行的任务。发送“当前”可查看状态。", entry.message);
    if (active) return;
    void this.finishTurn(turn.completion, entry.message).catch((error) => this.logger.error(`任务收尾失败: ${String(error)}`));
  }

  private async watchForConcurrentTurn(threadId: string, bridgeTurnId: string, ignoredTurnIds = new Set<string>()): Promise<void> {
    while (!this.controller.signal.aborted && this.state.activeTurn?.turnId === bridgeTurnId) {
      await sleep(5_000, this.controller.signal);
      if (this.controller.signal.aborted || this.state.activeTurn?.turnId !== bridgeTurnId) return;
      const activity = inspectThreadActivity(threadId);
      const foreignTurns = activity?.openTurnIds.filter((turnId) => turnId !== bridgeTurnId && !ignoredTurnIds.has(turnId)) ?? [];
      if (!foreignTurns.length) continue;
      this.state.activeTurn.phase = "检测到桌面端并发，正在保护性中断";
      this.state.activeTurn.recentOperation = `发现外部 turn ${foreignTurns[0]}`;
      this.state.activeTurn.lastProgressAt = Date.now();
      await this.store.save(this.state);
      await this.codex.interrupt(threadId).catch(() => false);
      const to = this.state.activeTurn?.replyTo ?? this.state.credentials?.allowedUserId;
      if (to) {
        await this.queueText(to, "检测到桌面端同时执行同一任务。为避免冲突，Bridge 已中断微信端 turn；请保留一个入口后重试。", this.state.activeTurn?.contextToken);
      }
      return;
    }
  }

  private async showCurrent(message: WeixinMessage): Promise<void> {
    const threadId = this.state.boundThreadId;
    if (!threadId) {
      await this.reply("当前没有绑定任务。", message);
      return;
    }
    const thread = (await this.codex.listThreads(100)).find((candidate) => candidate.id === threadId);
    const active = this.codex.activeTurn(threadId) ?? (this.state.activeTurn?.threadId === threadId ? this.state.activeTurn.turnId : undefined);
    if (!thread) {
      await this.reply(`当前绑定 ID：${threadId}\n状态：任务索引中未找到，建议发送“取消绑定”后重新选择。`, message);
      return;
    }
    const elapsed = this.state.activeTurn?.threadId === threadId
      ? Math.max(0, Math.floor((Date.now() - this.state.activeTurn.startedAt) / 1000))
      : undefined;
    await this.reply([
      `任务：${thread.name ?? (thread.preview || thread.id)}`,
      `ID：${thread.id}`,
      `项目：${thread.cwd}`,
      `状态：${active ? `执行中${elapsed === undefined ? "" : `（${elapsed} 秒）`}` : thread.status.type}`,
      ...(active ? [
        `阶段：${this.state.activeTurn?.phase ?? "执行中"}`,
        `最近操作：${this.state.activeTurn?.recentOperation ?? "暂无工具操作"}`,
        `最近反馈：${formatAge(this.state.activeTurn?.lastProgressAt)}`,
      ] : []),
    ].join("\n"), message);
  }

  private async stopCurrent(message: WeixinMessage): Promise<void> {
    const threadId = this.state.boundThreadId;
    if (!threadId) {
      await this.reply("当前没有绑定任务。", message);
      return;
    }
    const stopped = await this.codex.interrupt(threadId);
    if (this.state.activeTurn?.threadId === threadId) {
      this.state.activeTurn = undefined;
      await this.store.save(this.state);
    }
    await this.reply(stopped ? "已请求停止当前任务并清理后台终端。" : "当前任务没有正在执行的 turn。", message);
  }

  private async finishTurn(completion: Promise<TurnResult>, message: WeixinMessage): Promise<void> {
    const result = await completion;
    await this.weixin.setTyping(message.from_user_id!, this.state.contextToken, false);
    await this.finishRecoveredOrLiveTurn(result, message.from_user_id, message.context_token ?? this.state.contextToken);
  }

  private async handleNotification(event: CodexNotification): Promise<void> {
    const active = this.state?.activeTurn;
    if (!active || event.method !== "item/started") return;
    const params = event.params ?? {};
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    if (eventTurnId && eventTurnId !== active.turnId) return;
    if (Date.now() - this.lastProgressAt < 30_000) return;
    const item = params.item as Record<string, unknown> | undefined;
    const progress = item ? describeProgress(item) : undefined;
    if (!progress) return;
    if (progress === this.lastProgressText && Date.now() - this.lastProgressAt < 5 * 60_000) return;
    this.lastProgressAt = Date.now();
    this.lastProgressText = progress;
    active.phase = progress;
    active.recentOperation = progress;
    active.lastProgressAt = this.lastProgressAt;
    await this.store.save(this.state);
    const to = this.state.credentials?.allowedUserId;
    if (to) await this.queueText(to, `进度：${progress}`, this.state.contextToken).catch((error) => this.logger.warn(`阶段反馈发送失败: ${String(error)}`));
  }

  private async handleServerRequest(request: ServerRequestEvent): Promise<void> {
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      this.codex.respond(request.id, { decision: safeModeEnabled() ? "decline" : "acceptForSession" });
      return;
    }
    if (request.method === "currentTime/read") {
      this.codex.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(request.params.questions) ? request.params.questions as PendingUserInput["questions"] : [];
      this.pendingUserInput = { requestId: request.id, questions, receivedAt: Date.now() };
      this.state.pendingUserInput = { questions, receivedAt: this.pendingUserInput.receivedAt };
      if (this.state.activeTurn) {
        this.state.activeTurn.phase = "等待你的回答";
        this.state.activeTurn.recentOperation = "Codex 请求用户输入";
        this.state.activeTurn.lastProgressAt = Date.now();
      }
      await this.store.save(this.state);
      const prompt = questions.map((question, questionIndex) => {
        const options = question.options?.map((option, optionIndex) => `${optionIndex + 1}. ${option.label}`).join("\n");
        return `${questionIndex + 1}) ${question.question}${options ? `\n${options}` : ""}`;
      }).join("\n\n");
      const to = this.state.credentials?.allowedUserId;
      if (to) await this.queueText(to, `Codex 需要你的回答：\n${prompt}`, this.state.contextToken);
      return;
    }
    this.codex.respondError(request.id, `Weixin Bridge 不支持服务端请求 ${request.method}`);
  }

  private async answerUserInput(text: string, entry: InboxEntry): Promise<void> {
    const pending = this.pendingUserInput;
    if (!pending) return;
    const parts = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const answers: Record<string, { answers: string[] }> = {};
    for (let index = 0; index < pending.questions.length; index += 1) {
      const question = pending.questions[index];
      const raw = parts[index] ?? parts[0] ?? text;
      const optionIndex = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
      const value = optionIndex >= 0 && question.options?.[optionIndex]
        ? question.options[optionIndex].label
        : raw;
      answers[question.id] = { answers: [value] };
    }
    this.pendingUserInput = undefined;
    this.state.pendingUserInput = undefined;
    await this.store.save(this.state);
    if (pending.requestId !== undefined) {
      this.codex.respond(pending.requestId, { answers });
      await this.reply("已把回答提交给 Codex。", entry.message);
      return;
    }
    const threadId = this.state.boundThreadId;
    if (!threadId) {
      await this.reply("已保存回答，但当前没有绑定任务；请重新选择任务后再发送。", entry.message);
      return;
    }
    const recoveredAnswer = [
      "回答 Bridge 重启前 Codex 提出的问题：",
      ...pending.questions.map((question) => `${question.question}\n${answers[question.id]?.answers.join("；") ?? text}`),
    ].join("\n\n");
    await this.reply("已恢复重启前待回答的问题，正在把答案作为同一任务的新一轮提交。", entry.message);
    await this.dispatchPrompt(threadId, recoveredAnswer, entry);
  }

  private finishInbox(key: string): void {
    this.state.inbox = this.state.inbox.filter((item) => item.key !== key);
    this.state.processedIds.push(key);
    if (this.state.processedIds.length > 1000) this.state.processedIds.splice(0, this.state.processedIds.length - 1000);
  }

  private async recoverDispatchedMessages(): Promise<void> {
    const dispatched = this.state.inbox.filter((item) => item.status === "dispatched");
    if (!dispatched.length) return;
    this.logger.warn(`检测到 ${dispatched.length} 条重启前已提交消息，不会重复执行`);
    for (const entry of dispatched) this.finishInbox(entry.key);
    await this.store.save(this.state);
    const to = this.state.credentials?.allowedUserId;
    if (to) {
      await this.queueText(to, "Bridge 在任务提交后曾重启。为避免重复操作，旧消息没有再次执行；请发送“当前”检查状态。", this.state.contextToken).catch(() => undefined);
    }
  }

  private async recoverInterruptedTurn(): Promise<void> {
    const active = this.state.activeTurn;
    if (!active) return;
    this.logger.warn(`检测到重启前未完成 turn ${active.turnId}，开始恢复等待`);
    active.phase = "Bridge 重启后正在恢复任务状态";
    active.lastProgressAt = Date.now();
    await this.store.save(this.state);
    const snapshot = await this.codex.readTurnResult(active.threadId, active.turnId).catch(() => undefined);
    if (snapshot && isTerminalStatus(snapshot.status)) {
      await this.finishRecoveredOrLiveTurn(snapshot, active.replyTo, active.contextToken);
      return;
    }
    void this.waitForRecoveredTurn(active.threadId, active.turnId);
  }

  private async waitForRecoveredTurn(threadId: string, turnId: string): Promise<void> {
    while (!this.controller.signal.aborted && this.state.activeTurn?.turnId === turnId) {
      await sleep(5_000, this.controller.signal);
      if (this.controller.signal.aborted) return;
      const snapshot = await this.codex.readTurnResult(threadId, turnId).catch((error) => {
        this.logger.warn(`恢复任务状态读取失败: ${String(error)}`);
        return undefined;
      });
      if (!snapshot || !isTerminalStatus(snapshot.status)) continue;
      await this.finishRecoveredOrLiveTurn(
        snapshot,
        this.state.activeTurn?.replyTo,
        this.state.activeTurn?.contextToken,
      );
      return;
    }
  }

  private async finishRecoveredOrLiveTurn(result: TurnResult, to?: string, contextToken?: string): Promise<void> {
    const voiceReply = this.state.activeTurn?.turnId === result.turnId && this.state.activeTurn.voiceReply;
    const resultText = sanitizeBridgeOutput(result.text);
    const output = result.error
      ? `任务${result.status}：${result.error}${resultText ? `\n\n${resultText}` : ""}`
      : resultText || `任务状态为 ${result.status}`;
    const recipient = to ?? this.state.credentials?.allowedUserId;
    if (recipient && shouldSendTextResult(Boolean(voiceReply), Boolean(result.error))) {
      this.delivery.enqueueText(recipient, output, contextToken ?? this.state.contextToken);
    }
    if (recipient) {
      for (const file of extractExistingFiles(resultText).slice(0, 3)) {
        this.delivery.enqueueFile(recipient, file, path.basename(file), "file", contextToken ?? this.state.contextToken);
      }
      if (
        voiceReply
        && !result.error
        && this.state.boundThreadId === result.threadId
        && !this.realtimeSpeechSuppressed.has(result.threadId)
      ) {
        this.delivery.enqueueSpeech(
          recipient,
          result.threadId,
          output,
          contextToken ?? this.state.contextToken,
        );
      }
    }
    if (this.state.activeTurn?.turnId === result.turnId) this.state.activeTurn = undefined;
    this.state.pendingUserInput = undefined;
    this.pendingUserInput = undefined;
    await this.store.save(this.state);
    await this.delivery.flush();
  }

  private async reply(text: string, message: WeixinMessage): Promise<void> {
    const to = message.from_user_id ?? this.state.credentials!.allowedUserId;
    await this.queueText(to, text, message.context_token ?? this.state.contextToken);
  }

  private async queueText(to: string, text: string, contextToken?: string): Promise<void> {
    await this.delivery.queueText(to, text, contextToken);
  }

  private startHeartbeat(): void {
    this.updateHeartbeat("running");
    this.heartbeatTimer = setInterval(() => this.updateHeartbeat("running"), 30_000);
    this.heartbeatTimer.unref();
  }

  private updateHeartbeat(status: "running" | "network-backoff" | "stopping"): void {
    try {
      const file = heartbeatFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        pid: process.pid,
        updatedAt: Date.now(),
        status,
        activeTurnId: this.state?.activeTurn?.turnId,
        outbox: this.state?.outbox?.length ?? 0,
      }), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.logger.debug(`心跳写入失败（忽略）: ${String(error)}`);
    }
  }
}

export function formatRealtimeFailureText(failure: RealtimeFailure): string {
  const usageLimited = /(?:reached\s+(?:your\s+)?usage\s+limit|usage\s+limit\s+(?:has\s+been\s+)?reached)/i.test(
    `${failure.message}\n${failure.transcript ?? ""}`,
  );
  if (usageLimited) {
    return [
      "GPT-Live 已收到这条语音，但实验性语音后端返回了使用限制，因此没有生成语音回复。",
      "本条消息没有重复执行，也没有转用 API 计费。",
    ].filter(Boolean).join("\n");
  }
  if (failure.transcript) {
    return `GPT-Live 没有返回可发送的语音，已保留文字内容；为避免重复操作，没有再次执行任务：\n${failure.transcript}`;
  }
  return `GPT-Live 没有返回语音；为避免重复操作，没有再次执行任务。\n${failure.message}`;
}

export function sanitizeBridgeOutput(text: string): string {
  return text.replace(/^\s*\[COMPLETE\]\s*/i, "").trim();
}

export function shouldSendTextResult(voiceReply: boolean, failed: boolean): boolean {
  return !voiceReply || failed;
}

function messageKey(message: WeixinMessage): string {
  return String(message.message_id ?? message.client_id ?? message.item_list?.[0]?.msg_id ?? `${message.from_user_id}:${message.create_time_ms}`);
}

const SELECTION_PAGE_SIZE = 10;

export function formatCandidates(candidates: SelectionCandidate[], page = 0): string {
  const currentPage = clampSelectionPage(candidates, page);
  const pageCount = Math.max(1, Math.ceil(candidates.length / SELECTION_PAGE_SIZE));
  const start = currentPage * SELECTION_PAGE_SIZE;
  const visible = candidates.slice(start, start + SELECTION_PAGE_SIZE);
  return [
    `请选择要继续的任务或新任务项目（第 ${currentPage + 1}/${pageCount} 页，共 ${candidates.length} 项）：`,
    ...visible.map((candidate, index) => `${index + 1}. ${candidate.label}`),
    pageCount > 1 ? "请回复当前页序号、任务名称，或“下一页/上一页”。" : "请回复序号或任务名称。",
  ].join("\n");
}

export function findCandidateIndex(candidates: SelectionCandidate[], input: string, page = 0): number {
  const text = input.trim().toLocaleLowerCase();
  if (!text) return -1;
  if (/^\d+$/.test(text)) {
    const pageIndex = Number(text) - 1;
    if (pageIndex < 0 || pageIndex >= SELECTION_PAGE_SIZE) return -1;
    const index = clampSelectionPage(candidates, page) * SELECTION_PAGE_SIZE + pageIndex;
    return index < candidates.length ? index : -1;
  }
  const exact = candidates.findIndex((candidate) => candidate.label.trim().toLocaleLowerCase() === text);
  if (exact >= 0) return exact;
  const partial = candidates
    .map((candidate, index) => ({ index, label: candidate.label.toLocaleLowerCase() }))
    .filter((candidate) => candidate.label.includes(text));
  return partial.length === 1 ? partial[0]!.index : -1;
}

function clampSelectionPage(candidates: SelectionCandidate[], page: number): number {
  const lastPage = Math.max(0, Math.ceil(candidates.length / SELECTION_PAGE_SIZE) - 1);
  return Math.max(0, Math.min(Math.floor(page), lastPage));
}

function isNextPage(input: string): boolean {
  return ["下一页", "下页", "下一批"].includes(input.trim());
}

function isPreviousPage(input: string): boolean {
  return ["上一页", "上页", "上一批"].includes(input.trim());
}

function mask(value: string): string {
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}***${value.slice(-4)}`;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function formatAge(timestamp?: number): string {
  if (!timestamp) return "暂无";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "failed", "interrupted", "cancelled", "canceled"].includes(status);
}

function extractExistingFiles(text: string): string[] {
  const candidates = text.match(/[A-Za-z]:\\[^\r\n<>"|?*`]+/g) ?? [];
  const files = new Set<string>();
  for (const candidate of candidates) {
    let value = candidate.trim().replace(/[)\]。，；：,;:]+$/, "");
    while (!fs.existsSync(value) && value.includes(" ")) value = value.slice(0, value.lastIndexOf(" "));
    if (!fs.existsSync(value)) continue;
    try {
      if (fs.statSync(value).isFile()) files.add(path.resolve(value));
    } catch {
      // The result may mention a file that disappeared before delivery.
    }
  }
  return [...files];
}
