@echo off
setlocal
set "APP_URL=http://127.0.0.1:3100/?v=20260412"
set "EDGE_EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

if exist "%EDGE_EXE%" (
  start "" "%EDGE_EXE%" "%APP_URL%"
) else (
  start "" "%APP_URL%"
)

echo 如果浏览器没有自动打开，请手动访问：
echo %APP_URL%
endlocal
