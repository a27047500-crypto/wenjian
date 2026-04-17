@echo off
cd /d %~dp0
start "SOP Server" /min cmd /c "cd /d %~dp0 && node server.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:3100/editor.html?reset_cache=1&v=20260412
