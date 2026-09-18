@echo off
REM ============================================================================
REM multi-agent-bridge分发包 —— Windows安装向导（交互式）
REM分发版 v1.0.0 ·通用 ·可选择性注册 worker
REM
REM特性：
REM - %~dp0实时解析本地安装位，不改全局 PATH、不写死绝对路径
REM -探测已装 worker CLI（claude/codex/qwen/opencode/dsh），缺失可选择跳过
REM -私有配置（token/端点）交互式写入 %USERPROFILE%\.agents\.env，不入包、不进仓库
REM -可选向量记忆层按需补齐（默认纯文本）
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================================
echo multi-agent-bridge ^|分发包 v1.0.0安装向导 ^| Windows
echo ============================================================================
echo.

REM ----前置检查：node ----
where node >nul2>&1
if errorlevel1 (
  echo [X]未检测到 node。请先安装 Node.js18+（https://nodejs.org）后重跑本向导。
  pause
  exit /b1
)
for /f "delims=" %%N in ('node --version') do set NODEV=%%N
echo [OK] node %NODEV%

REM ----1.探测 worker CLI（调用 probe） ----
echo.
echo ----探测本机 worker CLI（可选择性安装/跳过） ----
node "%~dp0scripts\probe-cli.mjs"2>nul
if not errorlevel1 echo [说明]缺项均为「可选」，控制主控不依赖其中任意单个。
echo [提示]一键安装所有 worker: powershell -ExecutionPolicy Bypass -File ..\public-install\scripts\install-all-workers.ps1

REM ----2.路径确认 ----
echo.
echo ----安装位置 ----
echo当前解包目录： "%~dp0"
echo将以此目录为 bridge根（%CD%）。移动安装包会导致 MCP注册失效，请先解压到最终位置再运行。
set /p CONFIRM=确认使用该目录安装？(y/N):
if /i not "%CONFIRM%"=="y" (
  echo [X]已取消。请解压到最终目录后重跑。
  exit /b1
)

REM ----3.私有配置（写入 %USERPROFILE%\.agents\.env，不入包） ----
set ENV_FILE=%USERPROFILE%\.agents\.env
if not exist "%USERPROFILE%\.agents" mkdir "%USERPROFILE%\.agents"

echo.
echo ----私有配置（端点 + token，将写入 %ENV_FILE%） ----
echo [提示]以下输入仅写入你的个人配置目录，不会进入分发包/仓库。
echo [说明]默认使用 Anthropic官方云端点 (https://api.anthropic.com)
echo [提示]如需使用其他 provider，可后续手动编辑 %ENV_FILE%
echo.

REM检查是否已有配置
if exist "%ENV_FILE%" findstr /r /b "ANTHROPIC_BASE_URL=" "%ENV_FILE%" >nul2>&1 (
  echo [保留]检测到既有 ANTHROPIC_BASE_URL，未覆盖你的旧配置。手动编辑 %ENV_FILE%即可变更。
) else (
  set ENDPOINT_URL=https://api.anthropic.com
  echo ANTHROPIC_BASE_URL: %ENDPOINT_URL%
  set /p AUTH= ANTHROPIC_AUTH_TOKEN (必填，从 https://console.anthropic.com获取):
  if not defined AUTH (
    echo [警告]未提供 API Token。bridge将无法工作。请后续手动编辑 %ENV_FILE%
    set AUTH=^<YOUR_ANTHROPIC_API_KEY^>
  )
  (
    echo ANTHROPIC_BASE_URL=%ENDPOINT_URL%
    echo ANTHROPIC_AUTH_TOKEN=%AUTH%
    echo BRIDGE_CONTROLLER=claude
  )>>"%ENV_FILE%"
  echo [OK]已写入 %ENV_FILE%
)

REM ----4.注册 MCP（把 %~dp0绝对路径写入各 CLI配置） ----
echo.
echo ----注册 MCP到已装 CLI ----
set BRIDGE_DIR=%~dp0bridge
REM Claude的 .mcp.json
set CMAIN=%USERPROFILE%\.claude.json
if exist "%CMAIN%" (
  echo [Claude]检测到 ~/.claude.json。手动把以下 server加入 mcpServers，或：
)
echo (向导简化：请在 %CMAIN%的 mcpServers加入 shared-context，command=node, args=["%BRIDGE_DIR%\mcp\shared-context-server.mjs"])
echo （完整示例见 config\claude-mcp-config.json.tmpl，脚本占位 %BRIDGE_DIR%已换算为上述绝对路径）

REM ----4.5 技能软链（把 multi-agent 技能链接到各 CLI 技能根，可选）----
echo.
echo ----技能软链（可选：让 claude/codex/DSH 识别 multi-agent 技能）----
set "SKILL_SRC=%~dp0..\skills\multi-agent"
if not exist "%SKILL_SRC%\SKILL.md" (
  echo [提示]未发现技能包 skills\multi-agent，跳过。
  goto :skill_done
)
for %%R in ("%USERPROFILE%\.claude\skills" "%USERPROFILE%\.codex\skills" "%USERPROFILE%\.agents\skills") do call :link_skill "%%~R"
goto :skill_done

:link_skill
set "LINK_PATH=%~1\multi-agent"
if exist "%LINK_PATH%" (
  echo [跳过]已存在：%LINK_PATH%
  goto :eof
)
if not exist "%~1" mkdir "%~1"
mklink /J "%LINK_PATH%" "%SKILL_SRC%" >nul 2>&1
if errorlevel 1 (
  echo [提示]软链失败（可手工复制 skills\multi-agent 到 %LINK_PATH%）
) else (
  echo [OK]已软链：%SKILL_SRC% ^> %LINK_PATH%
)
goto :eof

:skill_done

REM ----5.向量层：先部署包内模型，再探测 ----
echo.
echo ----向量记忆层（可选） ----
REM若已下载 MiniLM模型（assets-optional\model-multilingual，见 download-vector-assets.ps1），部署到用户级 ~/.agents/vector/
if exist "%~dp0..\assets-optional\model-multilingual\model_quantized.onnx" (
  if not exist "%USERPROFILE%\.agents\vector\model-multilingual" mkdir "%USERPROFILE%\.agents\vector\model-multilingual"
  copy /y "%~dp0..\assets-optional\model-multilingual\*.onnx" "%USERPROFILE%\.agents\vector\model-multilingual\" >nul2>&1
  copy /y "%~dp0..\assets-optional\model-multilingual\*.json" "%USERPROFILE%\.agents\vector\model-multilingual\" >nul2>&1
  echo [OK]已部署向量模型到 %USERPROFILE%\.agents\vector\model-multilingual
) else (
  echo [提示]未发现模型。需要语义检索时运行: powershell -ExecutionPolicy Bypass -File assets-optional\download-vector-assets.ps1
)
node "%~dp0scripts\probe-vector.mjs" --json2>nul | findstr "vectorLayerReady" | findstr "true" >nul && (
  echo [OK]向量层已就绪：语义检索可用
) || (
  echo [提示]缺原生依赖（onnxruntime-node / sqlite-vec）。按 assets-optional\README.md的 npm install补齐后即启用；否则纯文本兜底，核心功能完整。
)

REM ----6.下一步 ----
echo.
echo ----下一步 ----
echo启动桥服务： node "%BRIDGE_DIR%\mcp\shared-context-server.mjs"
echo面板（可选）： node "%BRIDGE_DIR%\mcp\bridge-web-panel.mjs"
echo校验已装 CLI： node "%~dp0scripts\probe-cli.mjs"
echo配置指南：见 public-install\ENV_SETUP.md
echo.
echo安装向导完成。
pause
