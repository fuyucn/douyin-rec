#!/usr/bin/env bash
# clean.sh — 清理项目中的临时文件，方便分享
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "清理项目: $ROOT"

# Python 缓存
find . -type d -name "__pycache__" -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true
find . -type f -name "*.pyc" -not -path "./.venv/*" -delete 2>/dev/null || true
rm -rf .pytest_cache

# 录制产出 (视频、DB、日志)
rm -rf output

# macOS 元数据
find . -name ".DS_Store" -delete 2>/dev/null || true

# 临时计划文件
rm -f PLAN.md

# 虚拟环境
rm -rf .venv

# 构建产物
rm -rf dist build *.egg-info

echo "完成"
