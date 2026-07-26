import { describe, expect, it } from "vitest";
import { describeProgress } from "../src/progress.js";

describe("describeProgress", () => {
  it("explains why tests and builds are running", () => {
    expect(describeProgress({ type: "commandExecution", command: "npm test" })).toContain("确认刚才的修改");
    expect(describeProgress({ type: "commandExecution", command: "npm run build" })).toContain("正常构建");
  });

  it("explains source inspection and service recovery", () => {
    expect(describeProgress({ type: "commandExecution", command: "Get-Content src/bridge.ts" })).toContain("定位需要修改的位置");
    expect(describeProgress({ type: "commandExecution", command: "Start-ScheduledTask WeixinCodexBridge" })).toContain("不会再次意外断开");
  });

  it("names changed files and redacts command secrets", () => {
    expect(describeProgress({ type: "fileChange", changes: [{ path: "C:/repo/src/bridge.ts" }] })).toContain("bridge.ts");
    expect(describeProgress({ type: "commandExecution", command: "curl -H 'Bearer secret-value' example.test" })).not.toContain("secret-value");
  });
});
