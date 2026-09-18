#!/usr/bin/env bash
# 按需下载可选向量记忆层 embedding 模型（MiniLM-L12-v2 多语言，384 维，约 120MB）
# 仓库不内置大模型文件，需要向量记忆层（memory_search / task_sediment）时运行此脚本。
# 用法： bash assets-optional/download-vector-assets.sh
# 覆盖默认源： VECTOR_MODEL_URL=https://... bash assets-optional/download-vector-assets.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)/model-multilingual"
mkdir -p "$DIR"

BASE_URL="${VECTOR_MODEL_URL:-https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main}"
echo "下载 embedding 模型到: $DIR"
echo "默认源: HuggingFace Xenova/paraphrase-multilingual-MiniLM-L12-v2"
echo "（可用 VECTOR_MODEL_URL 环境变量覆盖为私有镜像源）"
echo

dl() {
  local rel="$1" out="$2"
  if [ -f "$out" ]; then echo "已存在，跳过: $out"; return; fi
  echo "下载 $rel ..."
  curl -fL "$BASE_URL/$rel" -o "$out"
}

dl "onnx/model_quantized.onnx" "$DIR/model_quantized.onnx"
dl "tokenizer.json"            "$DIR/tokenizer.json"
dl "config.json"               "$DIR/config.json"
dl "tokenizer_config.json"     "$DIR/tokenizer_config.json"

echo
echo "完成。校验向量层： node scripts/probe-vector.mjs --json"
echo "随后运行安装向导 launchers/install.sh 部署到 ~/.agents/vector/"
