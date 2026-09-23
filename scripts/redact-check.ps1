# scripts/redact-check.ps1
# Multi-agent 本地修改脱敏审查 — Windows 本地一键复跑脚本
# Deliverable: task-20260923-183038-447
# policy_version: 1.0.0
#
# 用法：
#   pwsh scripts/redact-check.ps1
#   pwsh scripts/redact-check.ps1 -Paths @('bridge','docs') -Report .\out\report.json
#
# 退出码：
#   0 = 未命中真实敏感模式
#   2 = 命中真实敏感模式（BLOCK）
#   1 = 运行错误

[CmdletBinding()]
param(
    [string[]]$Paths = @('bridge','config','launchers','scripts','docs','public-install','assets-optional','skills'),
    [string]$Report = ''
)

$ErrorActionPreference = 'Continue'

# 占位符/示例白名单（出现即放行）
$AllowlistRegex = 'example\.com|example\.org|example\.net|<your-email>|<YOUR_[A-Z_]+>|<INTERNAL_[A-Z_]+>|sk-ant-<|sk-xxxx|sk-proj-xxxx|AKIAIOSFODNN7EXAMPLE|127\.0\.0\.1|localhost|13800000000|13800138000|13000000000'

$Hits = 0
$Findings = New-Object System.Collections.Generic.List[object]

function Scan-Pattern {
    param([string]$Label, [string]$Pattern)
    $hits = @()
    foreach ($p in $Paths) {
        if (-not (Test-Path $p)) { continue }
        try {
            $matches = Select-String -Path (Get-ChildItem -Recurse -File -Path $p -ErrorAction SilentlyContinue).FullName `
                                    -Pattern $Pattern -ErrorAction SilentlyContinue
            foreach ($m in $matches) {
                $line = "$($m.Path):$($m.LineNumber):$($m.Line)"
                if ($line -notmatch $AllowlistRegex -and $line -notmatch '<YOUR_|<INTERNAL_') {
                    $hits += $line
                }
            }
        } catch { }
    }
    if ($hits.Count -gt 0) {
        Write-Host "==== [$Label] BLOCK HITS ====" -ForegroundColor Red
        $hits | ForEach-Object { Write-Host $_ }
        $script:Hits += $hits.Count
        $Findings.Add(@{ label = $Label; hits = $hits })
    }
}

Write-Host "[redact-check] paths: $($Paths -join ', ')"

# 1) API Key / Token / AccessKey
Scan-Pattern -Label 'real-api-key' -Pattern 'sk-ant-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{40,}|AKIA[0-9A-Z]{16}'

# 2) 本机路径
Scan-Pattern -Label 'real-local-path' -Pattern 'C:\\Users\\[^<]|/home/[a-z]|/(data|opt|srv|mnt)/[a-z]'

# 3) 真实邮箱（非占位符域）
$emailHits = @()
foreach ($p in $Paths) {
    if (-not (Test-Path $p)) { continue }
    try {
        $matches = Select-String -Path (Get-ChildItem -Recurse -File -Path $p -ErrorAction SilentlyContinue).FullName `
                                -Pattern '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -ErrorAction SilentlyContinue
        foreach ($m in $matches) {
            $line = "$($m.Path):$($m.LineNumber):$($m.Line)"
            if ($line -notmatch $AllowlistRegex) {
                $emailHits += $line
            }
        }
    } catch { }
}
if ($emailHits.Count -gt 0) {
    Write-Host '==== [real-email] BLOCK HITS ====' -ForegroundColor Red
    $emailHits | ForEach-Object { Write-Host $_ }
    $Hits += $emailHits.Count
    $Findings.Add(@{ label = 'real-email'; hits = $emailHits })
}

# 4) 真实手机号
Scan-Pattern -Label 'real-phone-cn' -Pattern '1[3-9][0-9]{9}'

# 5) .env / .agents / 本地日志快照（仅当是 git 仓库）
if (Test-Path '.git') {
    try {
        $ignored = & git status --ignored --porcelain 2>$null
        $envHits = $ignored | Where-Object { $_ -match '\.env$|\.agents/|debug\.log$|nohup\.out$' }
        if ($envHits) {
            Write-Host '==== [git-ignored-leak] BLOCK HITS ====' -ForegroundColor Red
            $envHits | ForEach-Object { Write-Host $_ }
            $Hits += $envHits.Count
            $Findings.Add(@{ label = 'git-ignored-leak'; hits = $envHits })
        }
    } catch { }
}

# 6) 人名 / 公司名 / 内部域名 / 内部代号关键字
Scan-Pattern -Label 'internal-name' -Pattern '内部|机密|companyname|internal\.corp|intra\.'

Write-Host "[redact-check] total BLOCK hits: $Hits"

if ($Report) {
    $dir = Split-Path -Parent $Report
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $obj = [pscustomobject]@{
        policy_version = '1.0.0'
        task_id        = 'task-20260923-183038-447'
        paths          = ($Paths -join ',')
        block_hits     = $Hits
        timestamp      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        findings       = $Findings
    }
    $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $Report -Encoding UTF8
    Write-Host "[redact-check] report: $Report"
}

if ($Hits -gt 0) { exit 2 } else { exit 0 }