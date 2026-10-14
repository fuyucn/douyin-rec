#!/usr/bin/env bash
# pr-risk-scan.sh — 按 diff 判定「危险类」(上传 / 清理 / 删除 / ledger 状态转换)。
#
# 用法:
#   scripts/pr-risk-scan.sh [base]            # 默认 base=origin/feat/hub-optimization,扫 base...HEAD
#   scripts/pr-risk-scan.sh --diff-file <f|-> # 直接读 unified diff(文件或 stdin),便于样例/测试
#
# 输出:第一行恒为 `PASS` 或 `RISK`;RISK 后每行一条命中原因(路径或内容)。
# 退出码:PASS=0,RISK=1,用法/取 diff 失败=2。review 门禁:RISK ⇒ 强制 needs-decision,不自动合并。
#
# 口径(宁可误报 RISK 让人确认,不可漏):
#   - 路径:非 .md 文件的路径含 upload / biliup / cleanup / ledger / unlink / rm-* 即 RISK。
#   - 内容:只扫生产代码与运维脚本的增/删行(packages/ 下非测试 ts/tsx/mjs/js、scripts/*.sh、
#     Dockerfile、remote/、.github/);文档、测试、本脚本自身不按内容扫(否则文档里提到词就误报)。
set -euo pipefail

DEFAULT_BASE="origin/feat/hub-optimization"
SELF="scripts/pr-risk-scan.sh"

if [[ "${1:-}" == "--diff-file" ]]; then
  [[ -n "${2:-}" ]] || { echo "用法: $0 --diff-file <file|->" >&2; exit 2; }
  if [[ "$2" == "-" ]]; then DIFF="$(cat)"; else DIFF="$(cat "$2")"; fi
else
  base="${1:-$DEFAULT_BASE}"
  DIFF="$(git diff -U0 --no-color --no-ext-diff "$base...HEAD")" || { echo "git diff 失败(base=$base)" >&2; exit 2; }
fi

PATH_RE='(upload|biliup|cleanup|clean-up|ledger|unlink|(^|/)rm[-_.])'
UPLOAD_RE='biliup|\bupload|--is-only-self|watermark'
DELETE_RE='cleanup|\bunlink(Sync)?\b|\brmSync\b|\brm\(|fs\.rm\b|rimraf|\brmdir|\brm +-[a-zA-Z]*[rf]|removeSource|deleteSource'
LEDGER_RE='sync_jobs|SyncLedger|needs_manual|\b(setState|advanceState|markDone|markFailed|upsertPending|sweepStale)\b'

reasons=()
cur=""

check_path() {
  [[ "$1" != *.md && "$1" != "$SELF" ]] && printf '%s' "$1" | grep -Eiq "$PATH_RE" && reasons+=("路径: $1")
  return 0
}

while IFS= read -r line; do
  case "$line" in
    "+++ b/"*) cur="${line#+++ b/}"; check_path "$cur" ;;
    "--- a/"*) cur="${line#--- a/}"; check_path "$cur" ;;  # 删除文件时 +++ 是 /dev/null,靠这行拿路径
    "+++ "*|"--- "*|"diff "*|"index "*|"@@"*) ;;
    [+-]*)
      [[ -n "$cur" && "$cur" != "$SELF" ]] || continue
      scan=0
      case "$cur" in
        packages/*.test.*|*/test/*|test/*) ;;
        packages/*.ts|packages/*.tsx|packages/*.mjs|packages/*.js) scan=1 ;;
        scripts/*.sh|Dockerfile*|docker-compose*|remote/*|.github/*) scan=1 ;;
      esac
      (( scan )) || continue
      body="${line:1}"
      for pair in "上传:$UPLOAD_RE" "清理/删除:$DELETE_RE" "ledger 状态转换:$LEDGER_RE"; do
        label="${pair%%:*}"; re="${pair#*:}"
        if printf '%s' "$body" | grep -Eiq "$re"; then
          reasons+=("内容[$label]: $cur")
        fi
      done ;;
  esac
done <<< "$DIFF"

if (( ${#reasons[@]} )); then
  echo "RISK"
  printf '%s\n' "${reasons[@]}" | sort -u
  exit 1
fi
echo "PASS"
