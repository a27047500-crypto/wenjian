param(
  [string]$TargetUrl = "http://127.0.0.1:3100",
  [string]$AppName = "Flow Docs"
)

$edgeCandidates = @(
  (Join-Path ${Env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path $Env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $edgeCandidates) {
  $edgeCandidates = Get-ChildItem "C:\Program Files", "C:\Program Files (x86)" -Recurse -Filter "msedge.exe" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName -First 1
}

if (-not $edgeCandidates) {
  Write-Error "Microsoft Edge was not found. Please install Edge first."
  exit 1
}

$edgePath = @($edgeCandidates)[0]
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "$AppName.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $edgePath
$shortcut.Arguments = "--app=$TargetUrl --disable-features=msUndersideButton"
$shortcut.WorkingDirectory = Split-Path $edgePath
$shortcut.IconLocation = $edgePath
$shortcut.Save()

Write-Output "Desktop shortcut created: $shortcutPath"
