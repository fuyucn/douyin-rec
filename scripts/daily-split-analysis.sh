#!/usr/bin/env bash
# daily-split-analysis.sh — 每天 10:30 自动跑分区录制/弹幕对比分析,结果追加到日志。
# 用途:VPS1/VPS2 分区录制期间,持续对比两侧产出(视频是否录到、弹幕是否拿到),
#       为「哪台机器/哪个 IP 更适合录什么 + 弹幕链路还差什么」积累数据。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/split-analysis-$(date +%Y%m%d).log"   # 仓库 logs/ 已 gitignore
mkdir -p "$(dirname "$LOG")"
{
  echo "──────── $(date '+%Y-%m-%d %H:%M:%S') 自动分析 ────────"
  "$ROOT/scripts/analyze-split-recording.sh"
} >> "$LOG" 2>&1
echo "已写入 $LOG"
