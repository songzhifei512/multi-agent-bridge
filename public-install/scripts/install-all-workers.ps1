# ============================================================================
# multi-agent-bridge -一键安装所有 worker CLI脚本（公网版）- Windows PowerShell
# ============================================================================
#用法：powershell -ExecutionPolicy Bypass -File install-all-workers.ps1
#说明：会从公网 npm安装所有支持的 worker CLI
# ============================================================================

Write-Host "============================================================================"
Write-Host " multi-agent-bridge |一键安装所有 worker CLI（公网 npm）"
Write-Host "============================================================================"
Write-Host ""

#检查 npm
try {
    $npmVersion = npm --version2>$null
    if (-not $?) {
        throw "npm not found"
    }
    Write-Host "[OK] npm $npmVersion"
} catch {
    Write-Host "[X]未检测到 npm。请先安装 Node.js18+ (https://nodejs.org)"
    exit1
}
Write-Host ""

#安装 Claude CLI
Write-Host "----安装 Claude CLI (@anthropic-ai/claude-code) ----"
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Host "[跳过] claude已安装"
} else {
    Write-Host "安装中..."
    npm install -g @anthropic-ai/claude-code
    Write-Host "[OK] claude安装完成"
}
Write-Host ""

#安装 Codex CLI
Write-Host "----安装 Codex CLI (@openai/codex) ----"
if (Get-Command codex -ErrorAction SilentlyContinue) {
    Write-Host "[跳过] codex已安装"
} else {
    Write-Host "安装中..."
    npm install -g @openai/codex
    Write-Host "[OK] codex安装完成"
}
Write-Host ""

#安装 opencode
Write-Host "----安装 opencode (opencode-ai) ----"
if (Get-Command opencode -ErrorAction SilentlyContinue) {
    Write-Host "[跳过] opencode已安装"
} else {
    Write-Host "安装中..."
    npm install -g opencode-ai
    Write-Host "[OK] opencode安装完成"
}
Write-Host ""

#安装 DSH CLI
Write-Host "----安装 DSH CLI (@deepseek-ai/dsh) ----"
if (Get-Command dsh -ErrorAction SilentlyContinue) {
    Write-Host "[跳过] dsh已安装"
} else {
    Write-Host "安装中..."
    npm install -g @deepseek-ai/dsh
    Write-Host "[OK] dsh安装完成"
}
Write-Host ""

# Qwen无需安装 CLI（端点方式）
Write-Host "---- Qwen (端点方式，无需 CLI) ----"
Write-Host "[说明] Qwen通过 QWEN_BASE_URL和 QWEN_API_KEY配置端点"
Write-Host "详见 public-install\ENV_SETUP.md"
Write-Host ""

Write-Host "============================================================================"
Write-Host "安装完成！"
Write-Host "============================================================================"
Write-Host ""
Write-Host "下一步："
Write-Host "1.配置 API密钥：见 public-install\ENV_SETUP.md"
Write-Host "2.运行探测脚本：node scripts\probe-cli.mjs"
Write-Host "3.运行安装向导：launchers\install-win.bat"
Write-Host ""
