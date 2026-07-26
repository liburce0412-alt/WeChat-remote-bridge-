import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { Logger } from "../logger.js";
import { dataDirectory } from "../paths.js";
import type { WeixinCredentials } from "../types.js";
import { WeixinClient, normalizeBaseUrl } from "./client.js";

export async function loginWeixin(logger: Logger, oldToken?: string): Promise<WeixinCredentials> {
  let client = WeixinClient.loginClient(logger);
  let qr = await client.createQr(oldToken ? [oldToken] : []);
  let refreshes = 0;
  let verifyCode: string | undefined;
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    await showQr(qr.qrcode_img_content);
    while (refreshes < 3) {
      const status = await client.pollQr(qr.qrcode, verifyCode);
      switch (status.status) {
        case "wait":
          break;
        case "scaned":
          verifyCode = undefined;
          process.stdout.write("已扫码，正在确认……\n");
          break;
        case "need_verifycode":
          verifyCode = (await rl.question("请输入微信显示的数字验证码：")).trim();
          break;
        case "scaned_but_redirect":
          if (status.redirect_host) client = client.withEndpoint(`https://${status.redirect_host}`);
          break;
        case "expired":
        case "verify_code_blocked":
          refreshes += 1;
          if (refreshes >= 3) throw new Error("二维码或验证码连续失效三次");
          qr = await WeixinClient.loginClient(logger).createQr(oldToken ? [oldToken] : []);
          verifyCode = undefined;
          await showQr(qr.qrcode_img_content);
          break;
        case "binded_redirect":
          throw new Error("该微信机器人已绑定，但服务端未返回新凭据；请先解除旧绑定再重试");
        case "confirmed":
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
            throw new Error("微信确认成功，但返回的凭据不完整");
          }
          return {
            botToken: status.bot_token,
            botId: status.ilink_bot_id,
            baseUrl: normalizeBaseUrl(status.baseurl),
            allowedUserId: status.ilink_user_id,
          };
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    throw new Error("微信登录未完成");
  } finally {
    rl.close();
  }
}

export async function loginWeixinInBackground(logger: Logger, oldToken?: string): Promise<WeixinCredentials> {
  let client = WeixinClient.loginClient(logger);
  let qr = await client.createQr(oldToken ? [oldToken] : []);
  let refreshes = 0;
  await showQrAndOpen(qr.qrcode_img_content);
  while (refreshes < 3) {
    const status = await client.pollQr(qr.qrcode);
    switch (status.status) {
      case "wait":
      case "scaned":
        break;
      case "scaned_but_redirect":
        if (status.redirect_host) client = client.withEndpoint(`https://${status.redirect_host}`);
        break;
      case "need_verifycode":
      case "verify_code_blocked":
        throw new Error("重新登录需要数字验证码，请在电脑运行 node dist/cli.js setup");
      case "expired":
        refreshes += 1;
        if (refreshes >= 3) throw new Error("自动重新登录二维码连续失效三次");
        qr = await WeixinClient.loginClient(logger).createQr(oldToken ? [oldToken] : []);
        await showQrAndOpen(qr.qrcode_img_content);
        break;
      case "binded_redirect":
        throw new Error("微信机器人仍绑定旧会话，无法自动刷新凭据");
      case "confirmed":
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          throw new Error("微信确认成功，但返回的凭据不完整");
        }
        return {
          botToken: status.bot_token,
          botId: status.ilink_bot_id,
          baseUrl: normalizeBaseUrl(status.baseurl),
          allowedUserId: status.ilink_user_id,
        };
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("微信自动重新登录未完成");
}

async function showQr(url: string): Promise<void> {
  const directory = dataDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "login-qr.png");
  await QRCode.toFile(file, url, { width: 480, margin: 2, errorCorrectionLevel: "M" });
  process.stdout.write("\n请用微信扫描二维码完成 ClawBot 绑定：\n\n");
  qrcode.generate(url, { small: true });
  process.stdout.write(`\n二维码图片：${file}\n如果二维码无法识别，请打开：${url}\n\n`);
}

async function showQrAndOpen(url: string): Promise<void> {
  const directory = dataDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "login-qr.png");
  await QRCode.toFile(file, url, { width: 480, margin: 2, errorCorrectionLevel: "M" });
  const child = spawn("C:\\Windows\\explorer.exe", [file], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`微信凭据失效，已生成并打开重新登录二维码：${file}\n`);
}
