$ErrorActionPreference = "Stop"
$bridgeTaskName = "WeixinCodexBridge"
$dataDirectory = if ($env:WEIXIN_CODEX_DATA_DIR) {
  $env:WEIXIN_CODEX_DATA_DIR
} else {
  Join-Path $env:LOCALAPPDATA "WeixinCodexBridge"
}
$heartbeat = Join-Path $dataDirectory "heartbeat.json"
$staleAfter = [TimeSpan]::FromMinutes(3)

$bridgeTask = Get-ScheduledTask -TaskName $bridgeTaskName
if ($bridgeTask.State -eq "Ready") {
  Start-ScheduledTask -TaskName $bridgeTaskName
  exit 0
}

if ($bridgeTask.State -eq "Running") {
  $stale = -not (Test-Path -LiteralPath $heartbeat)
  if (-not $stale) {
    $age = (Get-Date) - (Get-Item -LiteralPath $heartbeat).LastWriteTime
    $stale = $age -gt $staleAfter
  }
  if ($stale) {
    Stop-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $bridgeTaskName
  }
}
