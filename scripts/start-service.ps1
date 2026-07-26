$ErrorActionPreference = "Stop"

foreach ($taskName in @("WeixinCodexBridge", "WeixinCodexBridgeWatchdog")) {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
}
Start-ScheduledTask -TaskName "WeixinCodexBridgeWatchdog"
Write-Output "Weixin Codex Bridge service started"
