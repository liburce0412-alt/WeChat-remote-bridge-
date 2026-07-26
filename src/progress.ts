const SECRET_PATTERNS = [
  /(Bearer\s+)[^\s"']+/gi,
  /((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
];

export function describeProgress(item: Record<string, unknown>): string | undefined {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "commandExecution") return describeCommand(item.command);
  if (type === "fileChange") {
    const paths = extractPaths(item.changes).slice(0, 3);
    return paths.length > 0
      ? `正在修改 ${paths.join("、")}，把已确定的方案写入代码。`
      : "正在修改代码文件，把已确定的方案落实下来。";
  }
  if (type === "webSearch") {
    const query = shortText(item.query);
    return query ? `正在搜索“${query}”，补齐实现需要的资料。` : "正在搜索资料，核对实现依据。";
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    const tool = shortText(item.tool ?? item.name ?? item.toolName);
    return tool ? `正在调用 ${tool}，获取完成任务需要的信息。` : "正在调用工具，继续处理当前任务。";
  }
  return undefined;
}

function describeCommand(value: unknown): string {
  const command = sanitizeCommand(Array.isArray(value) ? value.join(" ") : String(value ?? ""));
  if (/\b(vitest|pytest|npm\s+(?:run\s+)?test)\b/i.test(command)) {
    return "正在运行测试，确认刚才的修改没有破坏现有功能。";
  }
  if (/\b(tsc|npm\s+run\s+build)\b/i.test(command)) {
    return "正在编译和检查类型，确认代码可以正常构建。";
  }
  if (/\b(npm\s+(?:install|audit)|pip\s+install)\b/i.test(command)) {
    return "正在安装或检查依赖，确保运行环境完整且没有已知依赖问题。";
  }
  if (/ScheduledTask|watchdog|install-autostart/i.test(command)) {
    return "正在检查并恢复微信 Bridge 后台服务，确保它不会再次意外断开。";
  }
  if (/\b(rg|Get-Content|Select-String|Get-ChildItem|findstr)\b/i.test(command)) {
    return "正在查找和阅读相关源码，定位需要修改的位置。";
  }
  if (/\b(git\s+diff|git\s+status)\b/i.test(command)) {
    return "正在检查代码改动，确认没有遗漏或误改。";
  }
  if (!command) return "正在执行项目命令，继续处理当前任务。";
  return `正在执行“${command.slice(0, 100)}”，继续处理当前任务。`;
}

function sanitizeCommand(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "$1***"), value)
    .replace(/\s+/g, " ")
    .trim();
}

function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : undefined;
}

function extractPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((change) => {
    if (!change || typeof change !== "object") return [];
    const path = (change as { path?: unknown }).path;
    return typeof path === "string" ? [path.split(/[\\/]/).pop() ?? path] : [];
  });
}
