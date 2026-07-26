# WeChat Remote Bridge for Codex

在个人微信与 Codex Desktop 任务之间建立一条可恢复的远程桥接。Bridge 复用微信 iLink
协议和本机 Codex app-server，不控制桌面窗口，也不需要 OpenAI API Key。

## 能做什么

- 通过微信续接、创建、查看和停止 Codex Desktop 任务。
- 仅接受首次扫码账号的私聊消息，忽略群聊和其他账号。
- 微信文字、语音转写、图片和文件都可以作为 Codex 输入。
- 默认返回文字；发送 `语音模式` 后，Codex 最终结果由 GPT-Live 朗读成
  `迟迟的语音.wav` 音频附件，中间进度仍为文字。
- GPT-Live 走 Codex app-server 的 WebRTC 与 ChatGPT 登录态，不录制系统声音，
  不调用单独计费的 STT/TTS API。
- 任务、待回答问题和文字/文件/语音投递队列均持久化；Bridge 重启不会重新执行已经
  提交的任务。

当前 iLink AI 联系人不支持可靠发送原生微信语音气泡，因此项目只发送 WAV 音频附件。

## 可靠性设计

- 历史搜索使用持久化增量缓存，每次更新有 1.5 秒时间预算；大型 rollout 只索引最近
  16 MB 的真实对话记录，不再同步读取数 GB 会话文件。
- DPAPI 状态保存采用可恢复串行队列，一次保存失败不会污染后续保存。
- outbox 区分文字、文件和待生成语音。GPT-Live 朗读正文会先保存，生成后再将 WAV
  落盘；只有微信确认发送后才出队。
- 微信消息使用稳定 client ID。重试长文字时，各分片 ID 不变，可减少重复消息。
- Codex RPC 默认 30 秒超时，微信 CDN 上传/下载为 60 秒超时并重试。
- 微信长轮询使用带抖动的指数退避，恢复后输出一次汇总，不再持续刷相同错误。
- Bridge 每 30 秒写入心跳；watchdog 不仅能拉起已退出的进程，也能重启超过三分钟
  没有心跳的假死进程。
- Codex app-server 意外退出时，Bridge 主动结束，由 Windows 计划任务和 watchdog
  重新拉起。

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本（CI 使用 Node.js 24）
- Codex Desktop 已登录 ChatGPT
- 可选：Python 与 faster-whisper CUDA 环境，用于微信没有自带转写时的本地语音识别

## 安装

```powershell
npm ci
npm run build
npm run setup
npm run doctor
npm start
```

`setup` 会显示微信二维码。凭据和运行状态使用当前 Windows 用户的 DPAPI 加密，保存在
`%LOCALAPPDATA%\WeixinCodexBridge`，不会写入项目目录。

完整验证：

```powershell
npm run check
```

安装登录自启和独立 watchdog：

```powershell
node dist/cli.js install-autostart
```

服务控制与状态：

```powershell
node dist/cli.js start-service
node dist/cli.js stop-service
node dist/cli.js status
```

`status` 会显示绑定任务、活动 turn、待发送 outbox、心跳时间和进程 PID。

## 微信指令

- `继续 <名称或历史内容>`
- `新任务 <需求>`
- `最近`
- `当前` / `查看情况`
- `换个任务`
- `停止`
- `取消绑定`
- `语音模式` / `/voice on`
- `退出语音` / `/voice off`
- `结束语音会话` / `/voice stop`
- `语音状态` / `/voice status`
- `关闭服务`
- `帮助`

候选任务使用简单的 `1` 到 `10` 序号和任务名称，不输出内部 `codex://` 编号。

## 配置

所有配置均为可选环境变量：

```powershell
$env:WEIXIN_CODEX_DATA_DIR = "D:\WeixinCodexBridge"
$env:WEIXIN_CODEX_WHISPER_MODEL = "D:\models\faster-whisper-large-v3-turbo"

$env:WEIXIN_CODEX_REALTIME_MODEL = "gpt-live-1-codex"
$env:WEIXIN_CODEX_REALTIME_VOICE = "sol"
$env:WEIXIN_CODEX_REALTIME_IDLE_MS = "300000"
$env:WEIXIN_CODEX_REALTIME_OUTPUT_TIMEOUT_MS = "30000"

# 只允许操作这些根目录，多个目录用分号分隔。
$env:WEIXIN_CODEX_ALLOWED_ROOTS = "C:\Users\me\Documents\Codex;D:\Projects"

# 可选安全模式：限制为 workspace-write，越界操作不会自动批准。
$env:WEIXIN_CODEX_SAFE_MODE = "1"
```

默认按远程自动化场景使用 `approvalPolicy=never` 和 `danger-full-access`。这是高权限模式：
绑定微信账号可以让 Codex 在本机执行命令和修改文件。公开部署或多人使用前，至少配置
`WEIXIN_CODEX_ALLOWED_ROOTS`；需要更强限制时同时开启安全模式。

## Codex 版本升级

运行时版本直接从已安装的 `@openai/codex/package.json` 读取，不再维护第二份硬编码版本。
使用升级脚本可在升级后自动执行类型检查、测试和构建：

```powershell
pwsh -File .\scripts\upgrade-codex.ps1 -Version 0.146.0-alpha.3.1
```

验证成功后再重启服务。脚本不会自动修改或覆盖微信加密状态。

## 开发与测试

```powershell
npm run typecheck
npm test
npm run build
```

真实 Codex、GPT-Live、微信和转写集成测试默认跳过，避免 CI 消耗本地登录态或 Voice
额度；只有显式设置对应的 `RUN_*_INTEGRATION` 环境变量时才运行。

Windows GitHub Actions 配置模板位于 `ci/windows.yml`。将它复制到
`.github/workflows/ci.yml` 即可启用；执行推送的 GitHub OAuth 令牌需要 `workflow` 权限。

腾讯协议适配来源与许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
