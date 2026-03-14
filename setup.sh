#!/usr/bin/env bash
# setup.sh — 首次 clone 或 pull 后运行，初始化所有依赖
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> 初始化 git submodule..."
git submodule update --init --recursive

echo "==> 检查 uv..."
if ! command -v uv &>/dev/null; then
    echo "未找到 uv，正在安装..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
fi

echo "==> 安装 Python 依赖..."
uv sync --extra ui

echo ""
echo "✓ 安装完成。启动 Web UI："
echo "  ./run.sh"
