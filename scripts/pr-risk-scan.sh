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
#   - 路径:敏感文件清单(收口 / 台账 / 清理 / 保留规则相关,见 SENSITIVE_FILES)命中即 RISK;
#     纯改名(diff 里只有 rename from/to 头、没有 +++/---)也按新旧两个路径判定。
#   - 内容:只扫生产代码与运维脚本(packages/ 下非测试 ts/tsx/mjs/js、scripts/*.sh、Dockerfile、
#     remote/、.github/);文档、测试、本脚本自身不按内容扫(否则文档里提到词就误报)。
#     git 模式用 --function-context 取 diff,按 hunk 判定:hunk 里有增/删行时,整个 hunk(含所在
#     函数的上下文行)一起匹配,单行翻转保留规则、在别处调用 ledger 方法也能命中。
set -euo pipefail

DEFAULT_BASE="origin/feat/hub-optimization"
SELF="scripts/pr-risk-scan.sh"

if [[ "${1:-}" == "--diff-file" ]]; then
  [[ -n "${2:-}" ]] || { echo "用法: $0 --diff-file <file|->" >&2; exit 2; }
  if [[ "$2" == "-" ]]; then DIFF="$(cat)"; else DIFF="$(cat "$2")"; fi
else
  base="${1:-$DEFAULT_BASE}"
  DIFF="$(git diff --function-context --no-color --no-ext-diff "$base...HEAD")" || { echo "git diff 失败(base=$base)" >&2; exit 2; }
fi

PATH_RE='(upload|biliup|cleanup|clean-up|ledger|unlink|(^|/)rm[-_.])'
UPLOAD_RE='biliup|\bupload|--is-only-self|watermark'
DELETE_RE='cleanup|\bunlink(Sync)?\b|\brmSync\b|\brm\(|fs\.rm\b|rimraf|\brmdir|\brm +-[a-zA-Z]*[rf]|removeSource|deleteSource|xmlKeepRule|stageAfterDone|keepSource|survivor'
LEDGER_RE='sync_jobs|SyncLedger|needs_manual|\b(setState|advanceState|markDone|markFailed|upsertPending|sweepStale)\b|\bledger\??\.[A-Za-z]+\('
# Files whose behaviour decides closeout / ledger state / what gets kept or deleted: any change is RISK.
SENSITIVE_FILES=(
  packages/orchestrator/src/pipeline.ts
  packages/orchestrator/src/segment-pipeline.ts
  packages/orchestrator/src/reconciler.ts
  packages/orchestrator/src/ledger.ts
  packages/orchestrator/src/node-side-upload.ts
  packages/core/src/survivors.ts
  packages/core/src/hub-ledger-contract.ts
  packages/app/src/node-pipeline.ts
  packages/app/src/orphan-cleanup.ts
  packages/cli/src/node-pipeline-commands.ts
)

reasons=()
cur=""
hunk=""
hunk_changed=0

check_path() {
  [[ -n "$1" && "$1" != "$SELF" ]] || return 0
  [[ "$1" != *.md ]] && printf '%s' "$1" | grep -Eiq "$PATH_RE" && reasons+=("路径: $1")
  local f
  for f in "${SENSITIVE_FILES[@]}"; do
    [[ "$1" == "$f" ]] && reasons+=("敏感文件: $1")
  done
  return 0
}

content_scanned() {
  case "$1" in
    packages/*.test.*|*/test/*|test/*) return 1 ;;
    packages/*.ts|packages/*.tsx|packages/*.mjs|packages/*.js) return 0 ;;
    scripts/*.sh|Dockerfile*|docker-compose*|remote/*|.github/*) return 0 ;;
  esac
  return 1
}

# Match the finished hunk (changed lines plus their function context) against the content rules.
flush_hunk() {
  if (( hunk_changed )) && [[ -n "$cur" && "$cur" != "$SELF" ]] && content_scanned "$cur"; then
    local pair label re
    for pair in "上传:$UPLOAD_RE" "清理/删除:$DELETE_RE" "ledger 状态转换:$LEDGER_RE"; do
      label="${pair%%:*}"; re="${pair#*:}"
      if printf '%s' "$hunk" | grep -Eiq "$re"; then
        reasons+=("内容[$label]: $cur")
      fi
    done
  fi
  hunk=""
  hunk_changed=0
}

while IFS= read -r line; do
  case "$line" in
    "+++ b/"*) cur="${line#+++ b/}"; check_path "$cur" ;;
    "--- a/"*) cur="${line#--- a/}"; check_path "$cur" ;;  # 删除文件时 +++ 是 /dev/null,靠这行拿路径
    "rename from "*) check_path "${line#rename from }" ;;
    "rename to "*) cur="${line#rename to }"; check_path "$cur" ;;
    "diff "*) flush_hunk; cur="" ;;
    "@@"*) flush_hunk ;;
    "+++ "*|"--- "*|"index "*) ;;
    [+-]*) hunk+="${line:1}"$'\n'; hunk_changed=1 ;;
    " "*) hunk+="${line:1}"$'\n' ;;
  esac
done <<< "$DIFF"
flush_hunk

if (( ${#reasons[@]} )); then
  echo "RISK"
  printf '%s\n' "${reasons[@]}" | sort -u
  exit 1
fi
echo "PASS"
