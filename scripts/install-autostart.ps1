param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$taskName = "WeixinCodexBridge"
$watchdogTaskName = "WeixinCodexBridgeWatchdog"
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$CliPath`" run" -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Weixin to Codex Desktop thread bridge" `
  -Force | Out-Null

$wscript = "C:\Windows\System32\wscript.exe"
$watchdogScript = Join-Path $ProjectRoot "scripts\watchdog.vbs"
$watchdogAction = New-ScheduledTaskAction `
  -Execute $wscript `
  -Argument "//B //Nologo `"$watchdogScript`"" `
  -WorkingDirectory $ProjectRoot
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$watchdogSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $watchdogTaskName `
  -Action $watchdogAction `
  -Trigger $watchdogTrigger `
  -Settings $watchdogSettings `
  -Description "Checks once per minute and restarts the Weixin Codex Bridge when needed" `
  -Force | Out-Null

Start-ScheduledTask -TaskName $watchdogTaskName
Write-Output "已安装登录自启任务：$taskName"
Write-Output "已安装独立守护任务：$watchdogTaskName"
