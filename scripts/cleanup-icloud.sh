#!/usr/bin/env bash
# 删除 icloud 下所有 _danmu.mp4 和 _livechat.mp4 文件
# 用法: bash scripts/cleanup-icloud.sh [--dryrun]

set -euo pipefail

DRYRUN=false
if [[ "${1:-}" == "--dryrun" ]]; then
  DRYRUN=true
fi

TARGET="$(cd "$(dirname "$0")/.." && pwd)/icloud"

# -L 让 find 跟随符号链接（icloud → iCloud Drive）
FIND="find -L"

echo "=== 查找 icloud 下的 _danmu.mp4 文件 ==="
$FIND "$TARGET" -type f -name '*_danmu.mp4' -print
echo "---"
echo "=== 查找 icloud 下的 _livechat.mp4 文件 ==="
$FIND "$TARGET" -type f -name '*_livechat.mp4' -print
echo "---"

FILES=()
while IFS= read -r f; do
  [[ -n "$f" ]] && FILES+=("$f")
done < <($FIND "$TARGET" -type f \( -name '*_danmu.mp4' -o -name '*_livechat.mp4' \))

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "没有找到匹配的文件"
  exit 0
fi

if $DRYRUN; then
  echo "🔍 [DRY RUN] 以下 ${#FILES[@]} 个文件将被删除："
  TOTAL_SIZE=0
  for f in "${FILES[@]}"; do
    sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
    sz_mb=$(echo "scale=1; $sz / 1048576" | bc 2>/dev/null || echo "?")
    TOTAL_SIZE=$((TOTAL_SIZE + sz))
    printf "  ❌  %-55s %s MB\n" "$(basename "$f")" "$sz_mb"
  done
  total_mb=$(echo "scale=1; $TOTAL_SIZE / 1048576" | bc 2>/dev/null || echo "?")
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "合计: ${#FILES[@]} 个文件，约 ${total_mb} MB"
  echo "🔍 [DRY RUN] 未执行任何删除操作"
  exit 0
fi

read -p "以上是找到的文件，确认删除？(y/N) " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "已取消"
  exit 0
fi

echo "=== 删除中... ==="
DELETED=0
SIZE=0
for f in "${FILES[@]}"; do
  sz=$(stat -f%z "$f" 2>/dev/null || echo 0)
  rm "$f"
  SIZE=$((SIZE + sz))
  DELETED=$((DELETED + 1))
done

if [[ $DELETED -eq 0 ]]; then
  echo "没有找到匹配的文件"
else
  SIZE_MB=$(( SIZE / 1048576 ))
  echo "✅ 删除了 $DELETED 个文件，释放约 ${SIZE_MB} MB"
fi
