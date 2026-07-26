export type BridgeCommand =
  | { type: "help" }
  | { type: "current" }
  | { type: "recent" }
  | { type: "switchTask" }
  | { type: "stop" }
  | { type: "unbind" }
  | { type: "shutdown" }
  | { type: "voiceOn" }
  | { type: "voiceOff" }
  | { type: "voiceStop" }
  | { type: "voiceStatus" }
  | { type: "continue"; term: string }
  | { type: "newTask"; request?: string };

export function parseCommand(input: string): BridgeCommand | undefined {
  const text = input.trim();
  const voiceCommand = /^\/voice\s+(on|off|stop|status)$/i.exec(text)?.[1]?.toLowerCase();
  if (text === "语音模式" || voiceCommand === "on") return { type: "voiceOn" };
  if (text === "退出语音" || voiceCommand === "off") return { type: "voiceOff" };
  if (text === "结束语音会话" || voiceCommand === "stop") return { type: "voiceStop" };
  if (text === "语音状态" || voiceCommand === "status") return { type: "voiceStatus" };
  if (text === "帮助") return { type: "help" };
  if (
    text === "当前"
    || text === "查看情况"
    || text === "查看进度"
    || text === "进度"
    || text === "状态"
    || text === "怎么样了"
    || /怎么.*(?:没有|没).*反馈/.test(text)
  ) return { type: "current" };
  if (text === "最近") return { type: "recent" };
  if (text === "换个任务" || text === "换任务" || text === "切换任务") return { type: "switchTask" };
  if (text === "停止" || text === "停止任务") return { type: "stop" };
  if (text === "取消绑定" || text === "退出当前任务") return { type: "unbind" };
  if (text === "关闭服务" || text === "关闭Bridge" || text === "关闭 Bridge") return { type: "shutdown" };
  if (text === "换成新建任务" || text === "新建任务" || text === "新任务") {
    return { type: "newTask" };
  }
  if (text.startsWith("继续 ")) return { type: "continue", term: text.slice(3).trim() };
  if (text.startsWith("新任务 ")) return { type: "newTask", request: text.slice(4).trim() };
  if (text.startsWith("新建任务 ")) return { type: "newTask", request: text.slice(5).trim() };
  if (text.startsWith("换成新建任务 ")) return { type: "newTask", request: text.slice(7).trim() };
  return undefined;
}
