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
