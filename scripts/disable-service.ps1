$ErrorActionPreference = "Stop"

foreach ($taskName in @("WeixinCodexBridgeWatchdog", "WeixinCodexBridge")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
  }
}
