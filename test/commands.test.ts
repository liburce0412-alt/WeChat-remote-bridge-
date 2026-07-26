import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  it.each(["当前", "查看情况", "查看进度", "进度", "状态", "怎么样了", "怎么没有反馈"])("maps %s to current", (text) => {
    expect(parseCommand(text)).toEqual({ type: "current" });
  });

  it.each(["换成新建任务", "新建任务", "新任务"])("enters new-task mode for %s", (text) => {
    expect(parseCommand(text)).toEqual({ type: "newTask" });
  });

  it("keeps an inline new-task request", () => {
    expect(parseCommand("新任务 修复登录失败")).toEqual({ type: "newTask", request: "修复登录失败" });
    expect(parseCommand("新建任务 修复登录失败")).toEqual({ type: "newTask", request: "修复登录失败" });
    expect(parseCommand("换成新建任务 修复登录失败")).toEqual({ type: "newTask", request: "修复登录失败" });
  });

  it("keeps management commands distinct from task prompts", () => {
    expect(parseCommand("停止")).toEqual({ type: "stop" });
    expect(parseCommand("关闭服务")).toEqual({ type: "shutdown" });
    expect(parseCommand("查看一下代码")).toBeUndefined();
  });

  it.each(["换个任务", "换任务", "切换任务"])("opens task selection for %s", (text) => {
    expect(parseCommand(text)).toEqual({ type: "switchTask" });
  });

  it.each([
    ["语音模式", "voiceOn"],
    ["/voice on", "voiceOn"],
    ["退出语音", "voiceOff"],
    ["/VOICE OFF", "voiceOff"],
    ["结束语音会话", "voiceStop"],
    ["/voice stop", "voiceStop"],
    ["语音状态", "voiceStatus"],
    ["/voice status", "voiceStatus"],
  ] as const)("maps %s to %s", (text, type) => {
    expect(parseCommand(text)).toEqual({ type });
  });
});
