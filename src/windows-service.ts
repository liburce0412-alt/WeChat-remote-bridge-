import { spawn } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "./paths.js";

export async function disableBridgeService(): Promise<void> {
  const script = path.join(PROJECT_ROOT, "scripts", "disable-service.ps1");
  await runPowerShell(script);
}

export async function controlBridgeService(mode: "start" | "stop"): Promise<string> {
  const script = path.join(PROJECT_ROOT, "scripts", `${mode}-service.ps1`);
  return await runPowerShell(script);
}

async function runPowerShell(script: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "pwsh.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { cwd: PROJECT_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `服务控制脚本退出码 ${code}`)));
  });
}
