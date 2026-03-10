#!/usr/bin/env bash
# run.sh — 一键启动 Web UI (本地开发，支持 Apple Metal 加速)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 检查 uv
if ! command -v uv &>/dev/null; then
    echo "未找到 uv，正在安装..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# 安装/同步依赖（已安装则秒过）
uv sync --extra ui

# 启动
exec uv run python main.py record --ui "$@"
