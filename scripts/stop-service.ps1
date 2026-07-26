$ErrorActionPreference = "Stop"

foreach ($taskName in @("WeixinCodexBridgeWatchdog", "WeixinCodexBridge")) {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
Write-Output "Weixin Codex Bridge service stopped"
