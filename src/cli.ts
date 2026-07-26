#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Bridge } from "./bridge.js";
import { Logger } from "./logger.js";
import { CODEX_VERSION, codexEntrypoint, dataDirectory, findWhisperModel, heartbeatFile, PROJECT_ROOT } from "./paths.js";
import { StateStore } from "./state.js";
import { controlBridgeService } from "./windows-service.js";
import { loginWeixin } from "./weixin/login.js";

const command = process.argv[2] ?? "help";
const logger = new Logger(path.join(dataDirectory(), "bridge.log"), process.env.WEIXIN_CODEX_DEBUG ? "debug" : "info");
const store = new StateStore();

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "run":
      await run();
      break;
    case "doctor":
      await doctor();
      break;
    case "status":
      await status();
      break;
    case "install-autostart":
      await autostart(true);
      break;
    case "uninstall-autostart":
      await autostart(false);
      break;
    case "start-service":
      process.stdout.write(`${await controlBridgeService("start")}\n`);
      break;
    case "stop-service":
      process.stdout.write(`${await controlBridgeService("stop")}\n`);
      break;
    default:
      printHelp();
  }
}

async function setup(): Promise<void> {
  const state = await store.load();
  const credentials = await loginWeixin(logger, state.credentials?.botToken);
  state.credentials = credentials;
  state.syncBuf = "";
  state.contextToken = undefined;
  state.inbox = [];
  state.processedIds = [];
  await store.save(state);
  process.stdout.write("\n微信绑定完成，凭据已使用 Windows DPAPI 加密保存。\n");
  process.stdout.write("下一步：npm run doctor，然后运行 npm start。\n");
}

async function run(): Promise<void> {
  const releaseLock = acquireLock();
  const bridge = new Bridge(store, logger);
  const shutdown = async () => {
    await bridge.stop().catch(() => undefined);
    releaseLock();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  try {
    await bridge.run();
  } finally {
    await shutdown();
  }
}

async function doctor(): Promise<void> {
  const checks: Array<[string, boolean, string]> = [];
  checks.push(["Node.js >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version]);
  checks.push(["Codex 固定运行时", fs.existsSync(codexEntrypoint()), CODEX_VERSION]);
  try {
    const version = await runProcess(process.execPath, [codexEntrypoint(), "--version"]);
    checks.push(["Codex 可启动", version.includes(CODEX_VERSION), version.trim()]);
  } catch (error) {
    checks.push(["Codex 可启动", false, String(error)]);
  }
  try {
    const state = await store.load();
    checks.push(["微信凭据", Boolean(state.credentials), state.credentials ? "已加密配置" : "未运行 setup"]);
  } catch (error) {
    checks.push(["微信凭据", false, String(error)]);
  }
  try {
    const output = await runProcess("py", ["-3", "-c", "import ctranslate2; print(ctranslate2.get_cuda_device_count())"]);
    checks.push(["CUDA 转写", Number(output.trim()) > 0, `${output.trim()} 个 CUDA 设备`]);
  } catch (error) {
    checks.push(["CUDA 转写", false, String(error)]);
  }
  const model = findWhisperModel();
  checks.push(["本地 Whisper 模型", Boolean(model), model ?? "未找到"]);
  checks.push([
    "项目目录限制",
    true,
    process.env.WEIXIN_CODEX_ALLOWED_ROOTS?.trim() || "未限制（可用 WEIXIN_CODEX_ALLOWED_ROOTS 配置）",
  ]);
  checks.push([
    "执行权限模式",
    true,
    process.env.WEIXIN_CODEX_SAFE_MODE === "1" ? "安全模式（workspace-write）" : "完全自动（danger-full-access）",
  ]);

  for (const [name, ok, detail] of checks) {
    process.stdout.write(`${ok ? "✅" : "❌"} ${name}：${detail}\n`);
  }
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function status(): Promise<void> {
  const state = await store.load();
  process.stdout.write(`微信：${state.credentials ? "已配置" : "未配置"}\n`);
  process.stdout.write(`绑定任务：${state.boundThreadId ?? "无"}\n`);
  process.stdout.write(`语音模式：${state.voiceModeEnabled ? "开启（音频附件回复）" : "默认（全部文字回复）"}\n`);
  process.stdout.write(`待处理消息：${state.inbox.length}\n`);
  process.stdout.write(`待发送回复：${state.outbox.length}\n`);
  process.stdout.write(`活动任务：${state.activeTurn?.turnId ?? "无"}\n`);
  const heartbeat = readHeartbeat();
  process.stdout.write(`服务心跳：${heartbeat ? `${Math.max(0, Math.round((Date.now() - heartbeat.updatedAt) / 1_000))} 秒前（PID ${heartbeat.pid}，${heartbeat.status}）` : "未找到"}\n`);
  process.stdout.write(`数据目录：${dataDirectory()}\n`);
}

async function autostart(install: boolean): Promise<void> {
  const script = path.join(PROJECT_ROOT, "scripts", install ? "install-autostart.ps1" : "uninstall-autostart.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
  if (install) args.push("-NodePath", process.execPath, "-CliPath", path.join(PROJECT_ROOT, "dist", "cli.js"), "-ProjectRoot", PROJECT_ROOT);
  const output = await runProcess("pwsh.exe", args);
  process.stdout.write(output);
}

function readHeartbeat(): { pid: number; updatedAt: number; status: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatFile(), "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.pid === "number"
      && typeof parsed.updatedAt === "number"
      && typeof parsed.status === "string"
    ) {
      return { pid: parsed.pid, updatedAt: parsed.updatedAt, status: parsed.status };
    }
  } catch {
    // Status must remain available before the service has ever started.
  }
  return undefined;
}

function acquireLock(): () => void {
  fs.mkdirSync(dataDirectory(), { recursive: true });
  const lock = path.join(dataDirectory(), "bridge.lock");
  if (fs.existsSync(lock)) {
    const oldPid = Number(fs.readFileSync(lock, "utf8"));
    try {
      process.kill(oldPid, 0);
      throw new Error(`Bridge 已在运行，PID=${oldPid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Bridge 已在运行")) throw error;
      fs.rmSync(lock, { force: true });
    }
  }
  fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  return () => fs.rmSync(lock, { force: true });
}

async function runProcess(executable: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: PROJECT_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `退出码 ${code}`)));
  });
}

function printHelp(): void {
  process.stdout.write([
    "weixin-codex setup               扫码绑定微信",
    "weixin-codex run                 前台运行 Bridge",
    "weixin-codex doctor              检查环境",
    "weixin-codex status              查看本地状态",
    "weixin-codex install-autostart   安装 Windows 登录自启",
    "weixin-codex uninstall-autostart 移除登录自启",
    "weixin-codex start-service       重新开启微信服务",
    "weixin-codex stop-service        关闭微信服务",
  ].join("\n") + "\n");
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
