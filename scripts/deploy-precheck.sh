#!/usr/bin/env bash
# deploy-precheck.sh — 部署前安全检查:确认本地 docker 与 VPS 都没有正在录制的任务。
#
# 用法: scripts/deploy-precheck.sh
#   退出码 0 = 可以部署;1 = 有录制,先别动;2 = 有节点状态未知(勿盲部署)。
#
# 规则(见 AGENTS.md「部署安全 guard」):任何重新部署前必须确认 recording !== true。
#   running=true 只表示任务已启用/等开播(重启安全);recording=true 才不能打断。
set -uo pipefail

LOCAL_API="${LOCAL_API:-http://127.0.0.1:7860}"
VPS_HOST="${VPS_HOST:-ubuntu@100.97.21.80}"
PY="$(dirname "$0")/deploy-precheck.py"

check() {
  local label="$1" json="$2"
  [ -z "$json" ] && { echo "  WARN $label: 取不到任务列表(API 不可达)"; return 2; }
  printf '%s' "$json" | python3 "$PY"
}

# ── 磁盘预检(2026-10-11 血的教训)────────────────────────────────────────────
# 背景:部署会重建 docker 镜像(数 GB 临时空间)。磁盘快满时构建中途 ENOSPC →
# OrbStack daemon 崩 → **master 停服数小时**。当时磁盘已 95% 仍照部署,直接踩爆。
# 所以除「有没有在录」,还必须查「磁盘还剩多少」。
#
# 阈值:master 要建镜像(最吃空间)→ 严格;VPS 只换 bundle(数百 MB)→ 放宽。
MASTER_MIN_GB="${MASTER_MIN_GB:-8}"
VPS_MIN_GB="${VPS_MIN_GB:-3}"

echo "=== 部署前检查:磁盘余量 ==="
disk_block=0
check_disk() {
  local label="$1" avail_gb="$2" min_gb="$3"
  if [ -z "$avail_gb" ]; then echo "  WARN $label: 取不到磁盘信息"; disk_block=1; return; fi
  if [ "$avail_gb" -lt "$min_gb" ]; then
    echo "  BLOCK $label 磁盘仅剩 ${avail_gb}G(< ${min_gb}G)—— 构建镜像会 ENOSPC,先清理"; disk_block=1; return
  fi
  echo "  OK $label 磁盘剩 ${avail_gb}G"
}
# master:本地根卷可用 GB。macOS 的 df 无 -BG,用 df -g(1G 块)取第 4 列。
master_avail="$(df -g / 2>/dev/null | awk 'NR==2{print $4}')"
[ -z "$master_avail" ] && master_avail="$(df -BG / 2>/dev/null | awk 'NR==2{gsub("G","",$4);print $4}')"
check_disk "master(本机)" "${master_avail:-}" "$MASTER_MIN_GB"
# VPS 两台(worker 只换 bundle,阈值低)。
for h in "$VPS_HOST" "${VPS2_HOST:-video-rec-2}"; do
  v_avail="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$h" 'df -BG / 2>/dev/null | awk "NR==2{gsub(\"G\",\"\",\$4);print \$4}"' 2>/dev/null)"
  check_disk "$h" "${v_avail:-}" "$VPS_MIN_GB"
done
if [ "$disk_block" -ne 0 ]; then
  echo
  echo "BLOCK 磁盘余量不足 —— 先清理再部署(2026-10-11 曾因磁盘满把 master 构建搞崩)。"
  exit 2
fi

echo
echo "=== 部署前检查:是否有正在录制的任务 ==="
rc=0
check "本地 docker" "$(curl -s -m 10 "$LOCAL_API/api/tasks" 2>/dev/null)" || rc=$?
vps_json="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" 'curl -s -m 10 http://127.0.0.1:7860/api/tasks' 2>/dev/null)" || vps_json=""
vrc=0; check "VPS worker" "$vps_json" || vrc=$?
# 取「最严重」:1(有录制) 优先于 2(未知)?不 —— 未知也要阻止,但 1 更明确。
# 只要任一侧为 1(BLOCK)就返回 1;否则取较大值(2=未知)。
if [ "$vrc" -eq 1 ] || [ "$rc" -eq 1 ]; then
  rc=1
elif [ "$vrc" -gt "$rc" ]; then
  rc=$vrc
fi

echo
case "$rc" in
  0) echo "OK 可以安全部署" ;;
  1) echo "BLOCK 有任务正在录制 —— 不要部署。等录制结束再跑本脚本确认。" ;;
  *) echo "WARN 有节点取不到任务列表 —— 先弄清状态再决定(勿盲部署)。" ;;
esac
exit "$rc"
