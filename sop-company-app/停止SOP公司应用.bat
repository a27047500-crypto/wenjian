@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*sop-company-app*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
