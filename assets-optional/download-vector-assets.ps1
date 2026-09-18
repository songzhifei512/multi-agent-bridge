# 按需下载可选向量记忆层 embedding 模型（MiniLM-L12-v2 多语言，384 维，约 120MB）
# 仓库不内置大模型文件，需要向量记忆层（memory_search / task_sediment）时运行此脚本。
# 用法： powershell -ExecutionPolicy Bypass -File assets-optional\download-vector-assets.ps1
# 覆盖默认源： $env:VECTOR_MODEL_URL="https://..." 然后运行
$ErrorActionPreference = 'Stop'

$dir = Join-Path $PSScriptRoot 'model-multilingual'
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$base = $env:VECTOR_MODEL_URL
if (-not $base) {
  $base = 'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main'
}
Write-Output "下载 embedding 模型到: $dir"
Write-Output "默认源: HuggingFace Xenova/paraphrase-multilingual-MiniLM-L12-v2"
Write-Output "（可用 VECTOR_MODEL_URL 环境变量覆盖为私有镜像源）"
Write-Output ""

$files = @(
  @{ name = 'model_quantized.onnx'; rel = 'onnx/model_quantized.onnx'; overwrite = $true },
  @{ name = 'tokenizer.json';       rel = 'tokenizer.json';            overwrite = $true },
  @{ name = 'config.json';          rel = 'config.json';               overwrite = $false },
  @{ name = 'tokenizer_config.json'; rel = 'tokenizer_config.json';    overwrite = $false }
)

foreach ($f in $files) {
  $out = Join-Path $dir $f.name
  if ((Test-Path $out) -and -not $f.overwrite) { Write-Output "已存在，跳过: $out"; continue }
  Write-Output "下载 $($f.rel) ..."
  Invoke-WebRequest -Uri "$base/$($f.rel)" -OutFile $out
}

Write-Output ""
Write-Output "完成。校验向量层： node scripts/probe-vector.mjs --json"
Write-Output "随后运行安装向导 launchers\install-win.bat 部署到 ~/.agents/vector/"
