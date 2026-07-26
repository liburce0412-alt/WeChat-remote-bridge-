# Security Policy

## 支持范围

该项目仍处于实验性预览阶段。安全修复只保证应用于：

| 版本 | 支持状态 |
| --- | --- |
| `main` | 支持 |
| 最新预览版 | 支持 |
| 更早版本 | 不保证 |

Codex app-server 和微信 iLink 均可能在上游更新后发生协议变化。报告问题前，请先在最新
`main` 分支或最新预览版上确认。

## 私下报告漏洞

请使用 GitHub 仓库的
[Private vulnerability reporting](https://github.com/liburce0412-alt/WeChat-remote-bridge-/security/advisories/new)
提交安全报告，不要创建公开 Issue。

报告中请尽量包括：

- 受影响版本或 commit；
- 问题影响和可利用条件；
- 最小复现步骤或概念验证；
- 建议修复方式（如有）；
- 已做过的公开披露（如有）。

请删除真实微信凭据、二维码、token、聊天内容、任务全文和本机个人路径。维护者会在确认
报告后通过 GitHub Security Advisory 协作修复和协调披露。

## 安全部署提醒

默认执行模式允许绑定的微信账号触发本机 Codex 执行命令和修改文件。使用者应：

- 只绑定自己控制的个人账号；
- 设置 `WEIXIN_CODEX_ALLOWED_ROOTS`；
- 在不需要完全本机权限时启用 `WEIXIN_CODEX_SAFE_MODE=1`；
- 使用独立 Windows 用户运行长期服务；
- 定期检查日志、依赖版本和已绑定任务；
- 不把 Bridge 作为多人共享服务暴露。

安全模式不是虚拟机或容器隔离。需要处理不可信输入时，应在独立虚拟机中部署。
