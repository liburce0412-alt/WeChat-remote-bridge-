param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("protect", "unprotect")]
  [string]$Mode
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$inputText = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes("WeixinCodexBridge/v1")

if ($Mode -eq "protect") {
  $plain = [Text.Encoding]::UTF8.GetBytes($inputText)
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($protected))
  exit 0
}

$cipher = [Convert]::FromBase64String($inputText.Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipher,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
