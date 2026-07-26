param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$Version
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
  npm install "@openai/codex@$Version" --save-exact
  npm run check
  Write-Output "Codex 已升级到 $Version，并通过类型检查、测试和构建。"
  Write-Output "如需让后台服务加载新版本，请运行：node dist/cli.js stop-service；node dist/cli.js start-service"
} finally {
  Pop-Location
}
