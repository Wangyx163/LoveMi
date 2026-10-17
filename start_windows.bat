@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
echo 启动 LoveMi v1.9 + P1B v1.11...
echo 访问 http://127.0.0.1:8765
node server.js
pause
