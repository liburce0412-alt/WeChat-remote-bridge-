import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import { WEIXIN_PROTOCOL_VERSION } from "../paths.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  type GetUpdatesResponse,
  type QrStatusResponse,
  type WeixinMessage,
} from "./types.js";

const APP_ID = "bot";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const CDN_TIMEOUT_MS = 60_000;

function normalizeBaseUrl(value?: string): string {
  if (!value) return DEFAULT_BASE_URL;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function baseInfo(): Record<string, string> {
  return {
    channel_version: WEIXIN_PROTOCOL_VERSION,
    bot_agent: "WeixinCodexBridge/0.1.0",
  };
}

export class WeixinClient {
  private typingTickets = new Map<string, string>();

  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly logger: Logger,
  ) {}

  static loginClient(logger: Logger): WeixinClient {
    return new WeixinClient(DEFAULT_BASE_URL, undefined, logger);
  }

  withEndpoint(baseUrl: string, token?: string): WeixinClient {
    return new WeixinClient(normalizeBaseUrl(baseUrl), token ?? this.token, this.logger);
  }

  async createQr(localTokenList: string[] = []): Promise<{ qrcode: string; qrcode_img_content: string }> {
    return await this.post(
      `ilink/bot/get_bot_qrcode?bot_type=3`,
      { local_token_list: localTokenList.slice(-10) },
      15_000,
      true,
    );
  }

  async pollQr(qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      return await this.get(endpoint, 35_000);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return { status: "wait" };
      this.logger.warn(`二维码状态查询失败，将重试: ${String(error)}`);
      return { status: "wait" };
    }
  }

  async getUpdates(syncBuf: string, timeoutMs = 35_000, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return await this.post(
        "ilink/bot/getupdates",
        { get_updates_buf: syncBuf, base_info: baseInfo() },
        timeoutMs,
        true,
        signal,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: syncBuf };
      }
      throw error;
    }
  }

  async sendText(to: string, text: string, contextToken?: string, clientIdPrefix?: string): Promise<void> {
    const chunks = splitText(text, 1800);
    for (const [index, chunk] of chunks.entries()) {
      const clientId = clientIdPrefix
        ? `weixin-codex:${clientIdPrefix}:${index + 1}`
        : `weixin-codex:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const msg: WeixinMessage = {
        from_user_id: "",
        to_user_id: to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
        context_token: contextToken,
      };
      const response = await this.post<{ ret?: number; errmsg?: string }>(
        "ilink/bot/sendmessage",
        { msg, base_info: baseInfo() },
        15_000,
        true,
      );
      if (response.ret && response.ret !== 0) {
        throw new Error(`sendMessage ret=${response.ret}: ${response.errmsg ?? "unknown"}`);
      }
    }
  }

  async sendMediaFile(to: string, filePath: string, contextToken?: string, clientId?: string): Promise<void> {
    const buffer = fs.readFileSync(filePath);
    const image = /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(filePath);
    const uploaded = await this.uploadMedia(to, buffer, image ? 1 : 3);
    const media = {
      encrypt_query_param: uploaded.downloadParam,
      aes_key: Buffer.from(uploaded.aesKey.toString("hex"), "ascii").toString("base64"),
      encrypt_type: 1,
    };
    const item = image
      ? { type: MessageItemType.IMAGE, image_item: { media, mid_size: uploaded.cipherSize } }
      : { type: MessageItemType.FILE, file_item: { media, file_name: path.basename(filePath), len: String(buffer.length) } };
    await this.sendItem(to, item, contextToken, clientId);
  }

  async sendAudioFile(
    to: string,
    audio: Buffer,
    fileName: string,
    contextToken?: string,
    clientId?: string,
  ): Promise<void> {
    const uploaded = await this.uploadMedia(to, audio, 3);
    await this.sendItem(to, {
      type: MessageItemType.FILE,
      file_item: {
        media: {
          encrypt_query_param: uploaded.downloadParam,
          aes_key: Buffer.from(uploaded.aesKey.toString("hex"), "ascii").toString("base64"),
          encrypt_type: 1,
        },
        file_name: path.basename(fileName),
        len: String(audio.length),
      },
    }, contextToken, clientId);
  }

  private async sendItem(
    to: string,
    item: NonNullable<WeixinMessage["item_list"]>[number],
    contextToken?: string,
    clientId?: string,
  ): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: clientId
            ? `weixin-codex:${clientId}`
            : `weixin-codex:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken,
        },
        base_info: baseInfo(),
      },
      15_000,
      true,
    );
    if (response.ret && response.ret !== 0) throw new Error(`sendMessage ret=${response.ret}: ${response.errmsg ?? "unknown"}`);
  }

  private async uploadMedia(to: string, plaintext: Buffer, mediaType: 1 | 3 | 4): Promise<{
    downloadParam: string;
    aesKey: Buffer;
    cipherSize: number;
  }> {
    const aesKey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString("hex");
    const cipherSize = Math.ceil((plaintext.length + 1) / 16) * 16;
    const upload = await this.post<{ upload_full_url?: string; upload_param?: string }>(
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: to,
        rawsize: plaintext.length,
        rawfilemd5: crypto.createHash("md5").update(plaintext).digest("hex"),
        filesize: cipherSize,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
        base_info: baseInfo(),
      },
      15_000,
      true,
    );
    const uploadUrl = upload.upload_full_url?.trim()
      || (upload.upload_param
        ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : "");
    if (!uploadUrl) throw new Error("微信 CDN 未返回上传地址");
    const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetchWithTimeout(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(encrypted),
        }, CDN_TIMEOUT_MS);
        if (!response.ok) throw new Error(`微信 CDN 上传失败: HTTP ${response.status}`);
        const downloadParam = response.headers.get("x-encrypted-param");
        if (!downloadParam) throw new Error("微信 CDN 响应缺少 x-encrypted-param");
        return { downloadParam, aesKey, cipherSize };
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("微信 CDN 上传失败");
  }

  async setTyping(userId: string, contextToken: string | undefined, typing: boolean): Promise<void> {
    try {
      let ticket = this.typingTickets.get(userId);
      if (!ticket) {
        const config = await this.post<{ ret?: number; typing_ticket?: string }>(
          "ilink/bot/getconfig",
          { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
          10_000,
          true,
        );
        ticket = config.typing_ticket;
        if (ticket) this.typingTickets.set(userId, ticket);
      }
      if (!ticket) return;
      await this.post(
        "ilink/bot/sendtyping",
        { ilink_user_id: userId, typing_ticket: ticket, status: typing ? 1 : 2, base_info: baseInfo() },
        10_000,
        true,
      );
    } catch (error) {
      this.logger.debug(`输入状态发送失败（忽略）: ${String(error)}`);
    }
  }

  async notifyStart(): Promise<void> {
    await this.post("ilink/bot/msg/notifystart", { base_info: baseInfo() }, 10_000, true);
  }

  async notifyStop(): Promise<void> {
    await this.post("ilink/bot/msg/notifystop", { base_info: baseInfo() }, 10_000, true);
  }

  private commonHeaders(authenticated: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": APP_ID,
      "iLink-App-ClientVersion": String(CLIENT_VERSION),
    };
    if (authenticated || this.token) {
      headers["Content-Type"] = "application/json";
      headers.AuthorizationType = "ilink_bot_token";
      headers["X-WECHAT-UIN"] = randomWechatUin();
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async get<T>(endpoint: string, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(endpoint, `${normalizeBaseUrl(this.baseUrl)}/`), {
        headers: this.commonHeaders(false),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`GET ${endpoint} ${response.status}: ${text}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T = Record<string, unknown>>(
    endpoint: string,
    body: unknown,
    timeoutMs: number,
    authenticated: boolean,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(endpoint, `${normalizeBaseUrl(this.baseUrl)}/`), {
        method: "POST",
        headers: this.commonHeaders(authenticated),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`POST ${endpoint} ${response.status}: ${text}`);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function splitText(text: string, limit: number): string[] {
  const normalized = text.trim() || "（任务已完成，但没有文字回复）";
  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export { normalizeBaseUrl };

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
