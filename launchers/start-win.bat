@echo off
REM ============================================================================
REM multi-agent-bridge - Windows启动脚本
REM用法：launchers\start-win.bat [--panel]
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set ROOT=%~dp0..
set ENV_FILE=%USERPROFILE%\.agents\.env

REM加载环境变量
if exist "%ENV_FILE%" (
  for /f "delims=" %%a in (%ENV_FILE%) do (
    set "%%a"
  )
) else (
  echo [提示]未找到 %ENV_FILE%，先跑 launchers\install-win.bat。
)

REM可选：启动面板
if "%1"=="--panel" (
  start "BridgePanel" node "%ROOT%\bridge\mcp\bridge-web-panel.mjs"
  echo [OK]已启动面板（端口3000）。
)

REM启动桥服务
echo [OK]启动桥服务 (Ctrl+C停止)...
node "%ROOT%\bridge\mcp\shared-context-server.mjs"
