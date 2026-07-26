# Changelog

本文档记录项目面向使用者的重要变化。版本号遵循
[Semantic Versioning](https://semver.org/)；`0.x` 阶段的接口和配置仍可能变化。

## [Unreleased]

### Planned

- 跟进 Codex app-server 与微信 iLink 的实验协议变化。
- 在具备 GitHub `workflow` 权限后启用仓库内 Windows CI。

## [0.1.0] - 2026-07-27

首个公开预览版。

### Added

- 通过个人微信查看、搜索、新建和续接 Codex Desktop 任务。
- 文字、图片、文件和微信语音输入。
- GPT-Live 语音模式，以普通 WAV 音频附件返回结果。
- inbox/outbox 持久化、消息去重、重启恢复和网络退避。
- Windows 计划任务、自启动、心跳守护和 Codex 依赖升级脚本。
- DPAPI 状态加密、日志敏感信息遮盖、目录允许列表和安全模式。
- 单元测试以及显式选择加入的真实集成测试。

### Known limitations

- 仅支持 Windows。
- 无法通过当前 iLink 链路发送原生微信语音气泡。
- Codex Realtime 与微信 iLink 都是实验性接口。

[Unreleased]: https://github.com/liburce0412-alt/WeChat-remote-bridge-/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/liburce0412-alt/WeChat-remote-bridge-/releases/tag/v0.1.0
