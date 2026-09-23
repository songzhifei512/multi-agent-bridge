@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM Resolve project root (parent of launchers\ dir)
cd /d "%~dp0.."
set "PROJECT_ROOT=%cd%"

REM ---- 0. AUTO_YES support ----
REM If AUTO_YES=1 is set in the environment (or the user passes --yes flag),
REM every interactive prompt defaults to y and the script runs to completion.
REM Useful for CI / first-time installs / re-runs.
if /i "%AUTO_YES%"=="1" goto :auto_yes_set
if /i "%AUTO_YES%"=="true" goto :auto_yes_set
if /i "%1"=="--yes" goto :auto_yes_set
if /i "%1"=="/y" goto :auto_yes_set
goto :auto_yes_done
:auto_yes_set
set AUTO_YES=1
echo [AUTO_YES=1] All prompts will default to y; script will run to completion.
:auto_yes_done

echo.
echo ============================================================
echo   multi-agent-bridge  ^|  Windows Install Wizard  v1.0.1
echo ============================================================
echo.

REM ---- Check node ----
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first.
  echo         Download: https://nodejs.org
  pause
  exit /b 1
)
for /f "delims=" %%N in ('node --version') do set NODEV=%%N
echo [OK] node %NODEV%

REM ---- 1. Probe worker CLI ----
echo.
echo ---- Detecting worker CLI ----
if exist "%PROJECT_ROOT%\scripts\probe-cli.mjs" (
  node "%PROJECT_ROOT%\scripts\probe-cli.mjs"
  echo [INFO] Missing workers are optional, not required for core function.
) else (
  echo [WARN] scripts\probe-cli.mjs not found, skipping probe.
)

REM ---- 2. Confirm install path ----
echo.
echo ---- Install location ----
echo Path: "%PROJECT_ROOT%"
echo This directory will be the bridge root. Moving it later breaks MCP registration.
echo.
set CONFIRM=n
if "%AUTO_YES%"=="1" set CONFIRM=y
set /p CONFIRM=Confirm using this directory? (y/N): 
if /i not "%CONFIRM%"=="y" (
  echo [Cancelled] Please move the package to final location first.
  pause
  exit /b 1
)

REM ---- 3. Private config (.env) ----
set ENV_FILE=%USERPROFILE%\.agents\.env
if not exist "%USERPROFILE%\.agents" mkdir "%USERPROFILE%\.agents"

echo.
echo ---- Private config (endpoint + token) ----
echo Config will be written to: %ENV_FILE%
echo Default endpoint: https://api.anthropic.com
echo (You can edit the file later to change provider)
echo.

set HAS_CONFIG=0
if exist "%ENV_FILE%" (
  findstr /b "ANTHROPIC_BASE_URL=" "%ENV_FILE%" >nul 2>&1
  if not errorlevel 1 (
    echo [Keep] Existing ANTHROPIC_BASE_URL found, not overwritten.
    set HAS_CONFIG=1
  )
)
if "%HAS_CONFIG%"=="0" goto :config_new
echo [Keep] Existing ANTHROPIC_BASE_URL found, not overwritten.
goto :config_done

:config_new
set ENDPOINT_URL=https://api.anthropic.com
echo Endpoint: %ENDPOINT_URL%
set AUTH=
if "%AUTO_YES%"=="1" goto :config_skip_token_prompt
set /p AUTH=  ANTHROPIC_AUTH_TOKEN (required, from https://console.anthropic.com): 
:config_skip_token_prompt 
if defined AUTH goto :config_write
echo [WARN] No API token provided. Bridge won't work. Edit %ENV_FILE% later.
set AUTH=^<YOUR_ANTHROPIC_API_KEY^>

:config_write
(
  echo ANTHROPIC_BASE_URL=%ENDPOINT_URL%
  echo ANTHROPIC_AUTH_TOKEN=%AUTH%
  echo BRIDGE_CONTROLLER=claude
)>>"%ENV_FILE%"
echo [OK] Written to %ENV_FILE%

:config_done

REM ---- 4. MCP registration guide ----
echo.
echo ---- MCP Registration ----
set SERVER_PATH=%PROJECT_ROOT%\bridge\mcp\shared-context-server.mjs
echo Add this MCP server to your CLI config:
echo.
echo   name:    shared-context
echo   command: node
echo   args:    ["%SERVER_PATH%"]
echo.
echo (Full example: %PROJECT_ROOT%\config\claude-mcp-config.json.tmpl)

REM Check installed CLIs
where claude >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [Claude] Detected. Config: %USERPROFILE%\.claude.json
)
where codex >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [Codex] Detected. Config: %USERPROFILE%\.codex\config.toml
)

REM ---- 4.5 DSH Sidebar Panel (auto-install) ----
echo.
echo ---- DSH Sidebar Panel ----
set DSH_ROOT=%USERPROFILE%\.dsh
set DSH_PLUGINS=%DSH_ROOT%\plugins
set PANEL_SRC=%PROJECT_ROOT%\dsh-panel
set PANEL_NAME=dsh-bridge-panel
set PANEL_LINK=%DSH_PLUGINS%\%PANEL_NAME%
set DSH_DESKTOP_PROFILE=%DSH_ROOT%\profiles\desktop

if not exist "%DSH_ROOT%" goto :dsh_skip_notfound
if not exist "%PANEL_SRC%\dist\index.js" goto :dsh_skip_notbuilt

echo [DSH] DSH detected at %DSH_ROOT%

REM Check if already installed as plugin
if exist "%PANEL_LINK%" goto :dsh_skip_installed

REM Ask user (default: yes)
echo.
set INSTALL_PANEL=y
if "%AUTO_YES%"=="1" goto :install_panel_done
set /p INSTALL_PANEL=Install DSH sidebar panel? (Y/n): 
:install_panel_done
if /i "%INSTALL_PANEL%"=="n" goto :dsh_done

REM Create plugins dir if needed
if not exist "%DSH_PLUGINS%" mkdir "%DSH_PLUGINS%"

REM Create junction (no admin rights needed on Windows for junctions)
mklink /J "%PANEL_LINK%" "%PANEL_SRC%" >nul 2>&1
if not errorlevel 1 goto :dsh_install_ok

REM Junction failed - fall back to copy (skip node_modules and .git)
echo [INFO] Junction not available, copying files instead...
xcopy /e /i /y "%PANEL_SRC%" "%PANEL_LINK%" /EXCLUDE:%PROJECT_ROOT%\launchers\dsh-copy-exclude.txt >nul 2>&1
if errorlevel 1 goto :dsh_install_failed

:dsh_install_ok
echo [OK] DSH panel installed: %PANEL_LINK%
goto :dsh_profile_check

:dsh_install_failed
echo [ERROR] Failed to install DSH panel.
echo         Try manually: node "%PANEL_SRC%\link-dev.mjs"
goto :dsh_done

:dsh_skip_notfound
echo [SKIP] DSH not detected (%DSH_ROOT% not found).
echo        Install DSH Desktop first, then re-run this wizard.
goto :dsh_done

:dsh_skip_notbuilt
echo [SKIP] dsh-panel not built (dist/index.js missing).
echo        Run "cd dsh-panel && npm install && npm run build" first.
goto :dsh_done

:dsh_skip_installed
echo [SKIP] Already installed: %PANEL_LINK%
REM Fall through to profile check

:dsh_profile_check
REM ---- 4.6 DSH profile registration ----
if not exist "%DSH_DESKTOP_PROFILE%" goto :dsh_done

set PROFILE_PKG=%DSH_DESKTOP_PROFILE%\package.json
set PROFILE_PATCH=%DSH_DESKTOP_PROFILE%\cordis.patch.yml
set PANEL_PKG=%PANEL_SRC%\package.json

echo.
echo ---- Registering dsh-bridge-panel into DSH desktop profile ----
echo Profile: %DSH_DESKTOP_PROFILE%

REM Verify panel package exposes patch export
findstr /c:"./cordis.patch.yml" "%PANEL_PKG%" >nul 2>&1
if errorlevel 1 (
  echo [WARN] %PANEL_PKG% does not expose ./cordis.patch.yml export.
)

REM (b) mutate profile/package.json: dependencies + bundles
set "LINK_PATH=%PANEL_SRC:\=\\%"
node "%PROJECT_ROOT%\scripts\install-dsh-profile.mjs" --profile "%DSH_DESKTOP_PROFILE%" --panel-pkg "%PANEL_PKG%" --link "%LINK_PATH%"
if not errorlevel 1 goto :dsh_profile_pkg_ok
echo [WARN] profile/package.json edit failed; sidebar activation incomplete.
goto :dsh_done
:dsh_profile_pkg_ok
echo [OK] profile dependencies + bundles updated.

REM (c) merge panel patch into profile cordis.patch.yml if missing
node "%PROJECT_ROOT%\scripts\merge-dsh-patch.mjs" "%PROFILE_PATCH%" "%PANEL_SRC%\cordis.patch.yml"
if not errorlevel 1 goto :dsh_profile_patch_ok
echo [WARN] cordis.patch.yml merge failed.
goto :dsh_done
:dsh_profile_patch_ok
echo [OK] profile cordis.patch.yml ready.
echo      Restart DSH Desktop to see the sidebar panel.

:dsh_done

REM ---- 5. Skill installation (copy, not symlink - no admin needed) ----
echo.
echo ---- Skill installation ----
set "SKILL_SRC=%PROJECT_ROOT%\skills\multi-agent"
if exist "%SKILL_SRC%\SKILL.md" goto :skill_install_start
echo [SKIP] skills\multi-agent not found, skipping.
goto :skill_done
:skill_install_start

call :install_skill "%USERPROFILE%\.claude\skills"
call :install_skill "%USERPROFILE%\.codex\skills"
call :install_skill "%USERPROFILE%\.agents\skills"
goto :skill_done

:install_skill
set "DEST=%~1\multi-agent"
if not exist "%DEST%" goto :install_skill_do
echo [SKIP] Already exists: %DEST%
goto :eof
:install_skill_do
if not exist "%~1" mkdir "%~1"
xcopy /e /i /y "%SKILL_SRC%" "%DEST%" >nul 2>&1
if not errorlevel 1 goto :install_skill_ok
echo [WARN] Copy failed. Manually copy skills\multi-agent to %DEST%
goto :eof
:install_skill_ok
echo [OK] Installed: %DEST%
goto :eof

:skill_done

REM ---- 6. Vector layer ----
echo.
echo ---- Vector memory (optional, gated by VECTOR_ENABLED) ----

REM Probe first (no install) so the user sees the current 4-axis status
node "%PROJECT_ROOT%\scripts\probe-vector.mjs"
if errorlevel 1 (
  echo [WARN] probe failed; continuing without reporting status.
)

set VECTOR_INSTALL=n
if "%AUTO_YES%"=="1" set VECTOR_INSTALL=y
set /p VECTOR_INSTALL=Install vector layer (download model + npm onnxruntime-node + sqlite-vec)? (y/N):
if /i not "%VECTOR_INSTALL%"=="y" goto :vector_done

REM Defer to the cross-platform installer.
REM We run it WITHOUT --strict because we want success even when partial
REM (some deps already in place). After install, the next `probe-vector.mjs`
REM run is the source of truth for the final ENABLED/OFF status.
echo.
echo [INFO] Calling install-vector-layer.mjs ...
node "%PROJECT_ROOT%\assets-optional\install-vector-layer.mjs"
echo [INFO] install-vector-layer exited with code %errorlevel% (non-zero is OK if deps were already present).

:vector_done
echo.
REM Final summary -- use a simple status check, not multi-stage findstr pipes
node "%PROJECT_ROOT%\scripts\probe-vector.mjs" --json > "%TEMP%\dsh-vector-final.json" 2>nul
findstr /c:"\"semanticSearchEnabled\": true" "%TEMP%\dsh-vector-final.json" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Semantic search: OFF (text-only fallback active)
  echo        To enable: run install-vector-layer.ps1, or set VECTOR_ENABLED=1
) else (
  echo [OK] Semantic search: ENABLED  (VECTOR_ENABLED=0 to disable)
)
del "%TEMP%\dsh-vector-final.json" >nul 2>&1

REM ---- Done ----
echo.
echo ============================================================
echo   Installation complete
echo ============================================================
echo.
echo Verify CLI:   node "%PROJECT_ROOT%\scripts\probe-cli.mjs"
echo DSH panel:    %DSH_PLUGINS%\%PANEL_NAME%
echo Troubleshoot: %PROJECT_ROOT%\docs\guides\troubleshooting.md
echo Quick start:  %PROJECT_ROOT%\README.md
echo.
pause
