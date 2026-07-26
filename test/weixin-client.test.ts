import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Logger } from "../src/logger.js";
import { WeixinClient, normalizeBaseUrl } from "../src/weixin/client.js";

describe("WeixinClient", () => {
  let server: http.Server;
  let baseUrl: string;
  const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];

  beforeEach(async () => {
    requests.length = 0;
    server = http.createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const binaryUpload = request.url === "/cdn-upload";
        requests.push({ url: request.url ?? "", headers: request.headers, body: binaryUpload ? raw : raw ? JSON.parse(raw) : undefined });
        if (binaryUpload) {
          response.setHeader("x-encrypted-param", "download-param");
          response.end();
          return;
        }
        response.setHeader("content-type", "application/json");
        if (request.url?.includes("getupdates")) {
          response.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }));
        } else if (request.url?.includes("getuploadurl")) {
          response.end(JSON.stringify({ upload_full_url: `${baseUrl}/cdn-upload` }));
        } else {
          response.end(JSON.stringify({ ret: 0 }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server failed");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("persists the opaque update cursor on the wire", async () => {
    const client = new WeixinClient(baseUrl, "bot-token", new Logger());
    const response = await client.getUpdates("cursor-1", 5_000);
    expect(response.get_updates_buf).toBe("next");
    expect(requests[0].url).toBe("/ilink/bot/getupdates");
    expect(requests[0].body).toMatchObject({ get_updates_buf: "cursor-1" });
    expect(requests[0].headers.authorization).toBe("Bearer bot-token");
    expect(requests[0].headers["ilink-app-id"]).toBe("bot");
  });

  it("sends text with the inbound context token", async () => {
    const client = new WeixinClient(baseUrl, "bot-token", new Logger());
    await client.sendText("wx-user", "hello", "context-1", "outbox-1");
    expect(requests[0].url).toBe("/ilink/bot/sendmessage");
    expect(requests[0].body).toMatchObject({
      msg: {
        to_user_id: "wx-user",
        client_id: "weixin-codex:outbox-1:1",
        context_token: "context-1",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      },
    });
  });

  it("uses deterministic client IDs for every retriable text chunk", async () => {
    const client = new WeixinClient(baseUrl, "bot-token", new Logger());
    await client.sendText("wx-user", `第一段\n${"长".repeat(1_800)}`, "context-1", "outbox-2");

    expect(requests).toHaveLength(2);
    expect(requests.map(({ body }) => (body as {
      msg: { client_id: string };
    }).msg.client_id)).toEqual([
      "weixin-codex:outbox-2:1",
      "weixin-codex:outbox-2:2",
    ]);
  });

  it("normalizes server-returned hosts", () => {
    expect(normalizeBaseUrl("ilink.example.test")).toBe("https://ilink.example.test");
    expect(normalizeBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
  });

  it("encrypts, uploads, and sends a file attachment through CDN", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-cdn-"));
    const file = path.join(directory, "result.txt");
    fs.writeFileSync(file, "result", "utf8");
    try {
      const client = new WeixinClient(baseUrl, "bot-token", new Logger());
      await client.sendMediaFile("wx-user", file, "context-1");
      expect(requests.map((request) => request.url)).toEqual([
        "/ilink/bot/getuploadurl",
        "/cdn-upload",
        "/ilink/bot/sendmessage",
      ]);
      expect(requests[2].body).toMatchObject({
        msg: {
          context_token: "context-1",
          item_list: [{ type: 4, file_item: { file_name: "result.txt", len: "6" } }],
        },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sends generated audio through the supported file attachment path", async () => {
    const client = new WeixinClient(baseUrl, "bot-token", new Logger());
    const wav = Buffer.from("RIFF-generated-audio");

    await client.sendAudioFile("wx-user", wav, "GPT-Live语音.wav", "context-1");

    expect(requests.map((request) => request.url)).toEqual([
      "/ilink/bot/getuploadurl",
      "/cdn-upload",
      "/ilink/bot/sendmessage",
    ]);
    expect(requests[0].body).toMatchObject({
      media_type: 3,
      to_user_id: "wx-user",
      rawsize: wav.length,
    });
    expect(requests[2].body).toMatchObject({
      msg: {
        context_token: "context-1",
        item_list: [{
          type: 4,
          file_item: {
            file_name: "GPT-Live语音.wav",
            len: String(wav.length),
          },
        }],
      },
    });
  });

});
