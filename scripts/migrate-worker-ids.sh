#!/usr/bin/env bash
# migrate-worker-ids.sh — 把 hub.config.json 的 worker id 从「手分配名字」迁到「节点自报 nodeId」。
#
# 背景(T-15):此前 worker id 由 master 按 workerSeq 分配(vps2 / worker-1 …),删了重建就换号,
# hub 规则里引用的 id 变幽灵 → 静默漏录。现改为节点自报 **16 字符短 hash nodeId**。
#
# 做三件事:
#   1. 读每个远端 worker 的 nodeId(ssh 跑 `_node-id`;要求该节点已部署含 `_node-id` 的新 bundle);
#   2. 写 hub.config.json:旧 id → nodeId(顺带把 name 改成人类可读的名字);
#   3. **同步改所有 hub 规则的 workers 引用** —— 漏掉这步 = 幽灵 id = 静默漏录。
#
# 前置:master 已部署新 bundle;目标节点可达。默认 dry-run,加 --apply 才写盘(写前自动备份)。
#
# 用法:
#   scripts/migrate-worker-ids.sh                     # dry-run
#   scripts/migrate-worker-ids.sh --apply             # 执行(自动备份到 /tmp)
#   scripts/migrate-worker-ids.sh --apply --root docker-data
#   scripts/migrate-worker-ids.sh --rename vps2=VPS1 --rename worker-1=VPS2
#
# 注意:local 是保留 id,**永不迁移**(master 自身,无 node.json)。
# 兼容 macOS 自带 bash 3.2(不用关联数组)。
set -euo pipefail

ROOT="docker-data"
APPLY=0
MAP="$(mktemp)"        # 行格式: oldid\tnewid\thostname
RENAMEF="$(mktemp)"    # 行格式: oldid\tname
trap 'rm -f "$MAP" "$RENAMEF"' EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --root) ROOT="$2"; shift 2 ;;
    --rename) printf '%s\n' "${2/=/	}" >> "$RENAMEF"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

CFG="$ROOT/config/hub.config.json"
HUBDIR="$ROOT/config/hub"

[[ -f "$CFG" ]] || { echo "✗ 找不到 $CFG" >&2; exit 1; }
command -v jq >/dev/null || { echo "✗ 需要 jq(brew install jq)" >&2; exit 1; }

echo "=== 迁移 worker id → nodeId($([[ $APPLY == 1 ]] && echo 执行 || echo dry-run))==="
echo "配置: $CFG"
echo

# ── 1) 读远端 nodeId ─────────────────────────────────────────────────────────
count=$(jq '.workers | length' "$CFG")
i=0
while [[ $i -lt $count ]]; do
  oldid=$(jq -r ".workers[$i].id" "$CFG")
  host=$(jq -r ".workers[$i].host // \"\"" "$CFG")
  droot=$(jq -r ".workers[$i].dataRoot // \"\"" "$CFG")
  [[ -z "$host" || "$host" == "null" ]] && host="$oldid"

  if [[ "$oldid" == "local" ]]; then
    echo "  [local] 保留 id=local(master 自身,不迁移)"
    i=$((i+1)); continue
  fi

  printf '  [%s] %s:%s → ' "$oldid" "$host" "$droot"
  ident=$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$host" "node $droot/dist/douyin-rec.mjs _node-id $droot" 2>/dev/null || true)
  newid=$(printf '%s' "$ident" | jq -r '.nodeId // empty' 2>/dev/null || true)
  newhost=$(printf '%s' "$ident" | jq -r '.hostname // empty' 2>/dev/null || true)
  if [[ -z "$newid" ]]; then
    echo "✗ 读不到 nodeId(未部署新 bundle 或节点不可达)—— 跳过"
  else
    echo "nodeId=$newid hostname=$newhost"
    printf '%s\t%s\t%s\n' "$oldid" "$newid" "$newhost" >> "$MAP"
  fi
  i=$((i+1))
done

if [[ ! -s "$MAP" ]]; then
  echo
  echo "没有可迁移的节点(nodeId 一个都没读到)。先部署 worker 新 bundle,再跑本脚本。"
  exit 0
fi

# name: --rename 覆盖 > node.json 的 hostname > 保留原名
name_for() {
  local id="$1" fallback="$2" nm
  nm=$(awk -F'\t' -v k="$id" '$1==k{print $2; exit}' "$RENAMEF")
  [[ -n "$nm" ]] && { printf '%s' "$nm"; return; }
  printf '%s' "$fallback"
}

# ── 2) 干跑:列出将做的改动 ────────────────────────────────────────────────────
echo
echo "--- hub.config.json 改动 ---"
while IFS=$'\t' read -r oldid newid newhost; do
  oldname=$(jq -r ".workers[] | select(.id==\"$oldid\") | .name // \"\"" "$CFG")
  newname=$(name_for "$oldid" "${newhost:-$oldname}")
  echo "  id:   $oldid → $newid"
  echo "  name: ${oldname:-<空>} → $newname"
done < "$MAP"

echo
echo "--- hub 规则 workers 引用改动 ---"
rule_changes=0
for f in "$HUBDIR"/*.json; do
  [[ -f "$f" ]] || continue
  ws=$(jq -c '.workers // empty' "$f")
  [[ -z "$ws" ]] && continue
  newws="$ws"
  while IFS=$'\t' read -r oldid newid _; do
    newws=$(printf '%s' "$newws" | jq -c --arg o "$oldid" --arg n "$newid" 'map(if .==$o then $n else . end) | unique')
  done < "$MAP"
  if [[ "$newws" != "$ws" ]]; then
    echo "  $(basename "$f"): $ws → $newws"
    rule_changes=$((rule_changes+1))
  fi
done
[[ $rule_changes -eq 0 ]] && echo "  (无改动)"

if [[ $APPLY == 0 ]]; then
  echo
  echo "=== dry-run 结束。确认无误后加 --apply 执行。 ==="
  exit 0
fi

# ── 3) 写盘(先备份) ──────────────────────────────────────────────────────────
BK="/tmp/hub-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp "$CFG" "$BK/"
cp "$HUBDIR"/*.json "$BK/" 2>/dev/null || true
echo
echo "已备份 → $BK"

tmp=$(mktemp)
cp "$CFG" "$tmp"
while IFS=$'\t' read -r oldid newid newhost; do
  # fallback 必须与 dry-run 一致(hostname):否则「干的」和「实的」改名不同(踩过)。
  newname=$(name_for "$oldid" "${newhost:-}")
  if [[ -n "$newname" ]]; then
    jq --arg o "$oldid" --arg n "$newid" --arg nm "$newname" \
      '(.workers[] | select(.id==$o)) |= (.id=$n | .name=$nm)' "$tmp" > "$tmp.2" && mv "$tmp.2" "$tmp"
  else
    jq --arg o "$oldid" --arg n "$newid" \
      '(.workers[] | select(.id==$o)) |= (.id=$n)' "$tmp" > "$tmp.2" && mv "$tmp.2" "$tmp"
  fi
done < "$MAP"
mv "$tmp" "$CFG"

for f in "$HUBDIR"/*.json; do
  [[ -f "$f" ]] || continue
  ws=$(jq -c '.workers // empty' "$f")
  [[ -z "$ws" ]] && continue
  newws="$ws"
  while IFS=$'\t' read -r oldid newid _; do
    newws=$(printf '%s' "$newws" | jq -c --arg o "$oldid" --arg n "$newid" 'map(if .==$o then $n else . end) | unique')
  done < "$MAP"
  [[ "$newws" == "$ws" ]] && continue
  jq --argjson w "$newws" '.workers=$w' "$f" > "$f.2" && mv "$f.2" "$f"
  echo "  改规则 $(basename "$f")"
done

echo
echo "=== 完成。验证 ==="
echo "  jq -r '.workers[] | \"\\(.id)\\t\\(.name)\"' $CFG"
echo "  grep -rl 'vps2\\|worker-1' $HUBDIR/ || echo '无旧 id 残留'"
