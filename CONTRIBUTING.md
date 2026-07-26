# Contributing

感谢你关注 WeChat Remote Bridge for Codex。

这个项目会操作本机 Codex、个人微信消息和本地文件。贡献时请优先保证安全边界、任务
幂等性和消息可恢复性，而不只是让正常路径能够运行。

## 开始之前

1. 在 GitHub Issues 中搜索是否已有相同问题。
2. Bug 请提供可复现步骤；较大的功能改动建议先开 Issue 说明用途和边界。
3. 安全漏洞不要发公开 Issue，请按 [`SECURITY.md`](SECURITY.md) 报告。

## 本地开发

要求 Windows、Node.js 22 或更高版本，以及可正常使用的 Codex Desktop。

```powershell
git clone https://github.com/liburce0412-alt/WeChat-remote-bridge-.git
Set-Location WeChat-remote-bridge-
npm ci
npm run check
```

开发时可使用：

```powershell
npm run typecheck
npm test
npm run build
```

## 测试原则

- 修改命令路由、持久化状态或 outbox 时，应增加覆盖恢复和重复提交的测试。
- 修改 Realtime 音频时，应覆盖分块、回合边界、超时、断线和不重复执行语义。
- 真实 Codex、微信、GPT-Live 和 Whisper 集成测试必须保持显式选择加入。
- 测试不得依赖维护者的微信凭据、任务 ID、用户名、绝对路径或个人环境变量。

真实集成测试的开关和前置条件见 README 的“开发与测试”章节。

## 提交 Pull Request

提交前请确认：

- `npm run check` 通过。
- 新行为已补充测试和文档。
- 没有提交 `.env`、日志、二维码、token、DPAPI 状态或个人路径。
- 没有在默认测试中发送真实微信消息或消耗 Voice 额度。
- 改动保持 Windows 与 PowerShell 7 兼容。

请让每个 Pull Request 聚焦一个问题，并在说明中写清楚：

- 解决了什么问题；
- 为什么选择这个方案；
- 如何验证；
- 是否改变配置、状态 schema、安全边界或恢复语义。

## 代码风格

- 使用 TypeScript 严格类型，避免无理由引入 `any`。
- 优先复用现有模块，避免把网络、状态和消息路由逻辑混在一起。
- 对实验协议的兼容逻辑集中封装，避免散落在业务流程中。
- 用户可见的错误应说明下一步操作，但不要输出凭据或敏感内容。

## 行为准则

参与本项目即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
