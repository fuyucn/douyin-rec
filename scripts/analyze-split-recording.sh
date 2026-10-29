#!/usr/bin/env bash
# analyze-split-recording.sh — 分析 VPS1/VPS2 分区录制的视频与弹幕结果。
#
# 用途:2026-10-08 起把一半房间分到 VPS2(全部开弹幕),本脚本对比两侧产出,
#       为「哪个 IP/节点更适合录什么」提供数据(也验证均衡模式/弹幕链路是否真的可用)。
#
# 输出:每节点 → 任务数/在录数、.ts/.xml 数量与总大小、**空 xml 数**(弹幕失败信号)、
#       session 数、以及「有 ts 但 xml 空」的异常房间清单。
set -uo pipefail

TS_TARGET="${1:-master}"   # 谁执行(在 master 上跑,两边都能经 SSH 到)

node_of() { case "$1" in
  vps1) echo "ubuntu@100.97.21.80";;
  vps2) echo "ubuntu@100.115.69.88";;
  local) echo "";;
esac; }

probe() { # $1=node  → 远端统计(纯 find/wc,轻量)
  local h; h=$(node_of "$1"); [ -z "$h" ] && { echo "(local 跳过)"; return; }
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null "$h" 'bash -s' <<'EOS'
R=/home/ubuntu/drec/recordings
ts=$(find "$R" -name "*.ts" 2>/dev/null | wc -l)
tsb=$(find "$R" -name "*.ts" -printf "%s\n" 2>/dev/null | awk '{s+=$1} END{print s+0}')
xml=$(find "$R" -name "*.xml" 2>/dev/null | wc -l)
sess=$(find "$R" -name "*.session.json" 2>/dev/null | wc -l)
# 空 xml:只有表头(<i>…</i>)无 <d/<gift/<member → 弹幕失败
emptyxml=0; fullxml=0
for f in $(find "$R" -name "*.xml" -size -8k 2>/dev/null); do
  if grep -qE "<d |<member |<gift " "$f" 2>/dev/null; then fullxml=$((fullxml+1)); else emptyxml=$((emptyxml+1)); fi
done
echo "ts=$ts tsBytes=$tsb xml=$xml session=$sess emptyXml=$emptyxml fullXml=$fullxml"
# 有 ts 但对应 xml 空 → 弹幕链路问题的房间
echo "--- 有ts但弹幕空 ---"
find "$R" -name "*.ts" 2>/dev/null | while read -r f; do
  x="${f%.ts}.xml"
  if [ -f "$x" ] && ! grep -qE "<d |<member |<gift " "$x" 2>/dev/null; then echo "  $(basename "$f")"; fi
done | head -20
EOS
}

# 注意:两台 VPS 的 host key 只在 master(docker) 容器里齐(本机不一定有 VPS2 的),
# 故整个统计**在 master 上下文里跑**,避免 Host key verification failed。
if docker ps --format "{{.Names}}" | grep -qx douyin-rec; then
  docker cp "$0" douyin-rec:/tmp/analyze.sh >/dev/null 2>&1
  docker exec douyin-rec bash /tmp/analyze.sh
else
  echo "⚠ master 容器不可用,回退到本机(可能因 host key 缺失而漏掉 VPS2)"
  echo "════ 录制/弹幕对比分析 $(date '+%Y-%m-%d %H:%M:%S') ════"
  for n in vps1 vps2; do
    echo; echo "──── $n ────"
    probe "$n"
  done
fi
echo; echo "════ 结束 ════"
