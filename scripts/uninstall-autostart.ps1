$ErrorActionPreference = "Stop"
foreach ($taskName in @("WeixinCodexBridgeTTS", "WeixinCodexBridgeWatchdog", "WeixinCodexBridge")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "已移除登录自启任务：$taskName"
  } else {
    Write-Output "登录自启任务不存在：$taskName"
  }
}
