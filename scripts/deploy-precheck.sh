#!/usr/bin/env bash
# deploy-precheck.sh — 部署前安全检查:确认本地 docker 与 VPS 都没有正在录制的任务。
#
# 用法: scripts/deploy-precheck.sh
#   退出码 0 = 可以部署;1 = 有录制,先别动;2 = 有节点状态未知(勿盲部署)。
#
# 规则(见 AGENTS.md「部署安全 guard」):任何重新部署前必须确认 recording !== true,且没有上传在途
#   (running.biliup>0 / 新鲜 phase=uploading;三态口径见 scripts/deploy-precheck.py 头注释)。
#   running=true 只表示任务已启用/等开播(重启安全);recording=true 才不能打断。
set -uo pipefail

LOCAL_API="${LOCAL_API:-http://127.0.0.1:7860}"
VPS_HOST="${VPS_HOST:-ubuntu@100.97.21.80}"
PY="$(dirname "$0")/deploy-precheck.py"

UPLOADING_STALE_MS="${UPLOADING_STALE_MS:-21600000}"   # a phase=uploading result older than this (6h) no longer counts
LOCAL_DATA_ROOT="${LOCAL_DATA_ROOT:-$(dirname "$0")/../docker-data}"
VPS_DATA_ROOT="${VPS_DATA_ROOT:-\$HOME/drec}"             # expanded on the node
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Counts fresh phase=uploading node-result files under <root>/stage; prints a number or "unknown".
# Malformed files count as fresh (fail closed); a missing stage dir is "unknown", never 0.
UPLOADING_PY='
import json, os, sys, time
root, stale = sys.argv[1], int(sys.argv[2])
if not os.path.isdir(root):
    print("unknown"); sys.exit(0)
now, n = time.time() * 1000, 0
for dp, _, fs in os.walk(root):
    if ".drec-node-result.json" not in fs:
        continue
    try:
        d = json.load(open(os.path.join(dp, ".drec-node-result.json")))
        if d.get("phase") == "uploading" and now - float(d.get("atMs", 0)) <= stale:
            n += 1
    except Exception:
        n += 1
print(n)
'

# fetch_proc KIND TARGET -> writes $TMP/proc.json, prints the HTTP status (0 = unreachable)
fetch_proc() {
  local kind="$1" target="$2" raw code
  if [ "$kind" = local ]; then
    raw="$(curl -s -m 10 -w '\n%{http_code}' "$target/api/proc/active" 2>/dev/null)" || raw=""
  else
    raw="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" "curl -s -m 10 -w '\n%{http_code}' http://127.0.0.1:7860/api/proc/active" 2>/dev/null)" || raw=""
  fi
  code="${raw##*$'\n'}"
  case "$code" in ''|*[!0-9]*) code=0 ;; esac
  printf '%s' "${raw%$'\n'*}" > "$TMP/proc.json"
  echo "$code"
}

# check_node LABEL KIND(local|ssh) TARGET(api base | ssh host) DATA_ROOT -> exit 0 ok / 1 block / 2 unknown
check_node() {
  local label="$1" kind="$2" target="$3" root="$4" code up="unknown"
  : > "$TMP/tasks.json"; : > "$TMP/proc.json"
  if [ "$kind" = local ]; then
    curl -s -m 10 "$target/api/tasks" -o "$TMP/tasks.json" 2>/dev/null || : > "$TMP/tasks.json"
  else
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" 'curl -s -m 10 http://127.0.0.1:7860/api/tasks' > "$TMP/tasks.json" 2>/dev/null || : > "$TMP/tasks.json"
  fi
  code="$(fetch_proc "$kind" "$target")"
  if [ "$code" = 404 ]; then   # old bundle: blocking-path uploads are invisible to the queue, read result files
    if [ "$kind" = local ]; then
      up="$(python3 -c "$UPLOADING_PY" "$root/stage" "$UPLOADING_STALE_MS" 2>/dev/null)" || up=unknown
    else
      up="$(printf '%s' "$UPLOADING_PY" | ssh -o ConnectTimeout=10 -o BatchMode=yes "$target" "python3 - \"$root/stage\" $UPLOADING_STALE_MS" 2>/dev/null)" || up=unknown
    fi
    [ -n "$up" ] || up=unknown
  fi
  python3 "$PY" --label "$label" --tasks "$TMP/tasks.json" --proc-status "$code" --proc "$TMP/proc.json" --uploading "$up"
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
echo "=== 部署前检查:录制与上传 ==="
rc=0
worst() { # BLOCK(1) beats UNKNOWN(2) beats OK(0)
  if [ "$1" -eq 1 ] || [ "$2" -eq 1 ]; then echo 1; elif [ "$1" -gt "$2" ]; then echo "$1"; else echo "$2"; fi
}
nrc=0; check_node "master(本机)" local "$LOCAL_API" "$LOCAL_DATA_ROOT" || nrc=$?; rc="$(worst "$rc" "$nrc")"
nrc=0; check_node "VPS1($VPS_HOST)" ssh "$VPS_HOST" "$VPS_DATA_ROOT" || nrc=$?; rc="$(worst "$rc" "$nrc")"
nrc=0; check_node "VPS2(${VPS2_HOST:-video-rec-2})" ssh "${VPS2_HOST:-video-rec-2}" "$VPS_DATA_ROOT" || nrc=$?; rc="$(worst "$rc" "$nrc")"

echo
case "$rc" in
  0) echo "OK 可以安全部署" ;;
  1) echo "BLOCK 有任务正在录制或上传 —— 不要部署。等结束再跑本脚本确认。" ;;
  *) echo "WARN 有节点状态未知(不可达/超时/503) —— 先弄清状态再决定(勿盲部署)。" ;;
esac
exit "$rc"
