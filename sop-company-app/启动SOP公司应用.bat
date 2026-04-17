@echo off
setlocal
cd /d %~dp0

set "APP_URL=http://127.0.0.1:3100/?v=20260412"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "EDGE_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if not exist "%NODE_EXE%" (
  echo 未找到 Node.js：%NODE_EXE%
  echo 请先安装 Node.js，或手动运行 server.js
  pause
  exit /b 1
)

start "SOP Server" /min cmd /c "cd /d %~dp0 && \"%NODE_EXE%\" server.js"
timeout /t 3 /nobreak >nul

if exist "%EDGE_EXE%" (
  start "" "%EDGE_EXE%" "%APP_URL%"
) else (
  start "" "%APP_URL%"
)

echo 服务已启动。
echo 如果浏览器没有自动打开，请手动访问：
echo %APP_URL%
endlocal
