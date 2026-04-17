@echo off
setlocal
cd /d %~dp0

set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not exist "%NODE_EXE%" (
  echo 未找到 Node.js：%NODE_EXE%
  echo 请先安装 Node.js，或手动运行 server.js
  pause
  exit /b 1
)

start "SOP Server" /min cmd /c "cd /d %~dp0 && \"%NODE_EXE%\" server.js"
timeout /t 3 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop-client\show-lan-url.ps1"
pause
endlocal
