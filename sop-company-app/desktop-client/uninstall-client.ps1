param(
  [string]$AppName = "Flow Docs"
)

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "$AppName.lnk"

if (Test-Path $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Output "Desktop shortcut removed: $shortcutPath"
} else {
  Write-Output "Desktop shortcut was not found."
}
