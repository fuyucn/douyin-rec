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
#     git 模式用 --function-context 取 diff,按 hunk 判定:hunk 里有增/删行时,连同 hunk 开头 3 行
#     (所在函数签名)、hunk 头的函数名与改动前后各 20 行上下文一起匹配,单行翻转保留规则、在别处调用 ledger 方法也能命中。
#   - 路径同时取自 `diff --git` 头(权限变更、二进制、带引号路径只有这一行)。
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

# Display-only web modules (dictionary / toast text / progress rows): a content hit there is listed as a
# note, not a RISK. Their words ("upload", "uploading") are labels, not upload behaviour. Path and
# sensitive-file rules still apply, and any web file not listed here keeps the full content rules.
DISPLAY_ONLY=(
  packages/web/src/lib/i18n.tsx
  packages/web/src/lib/notification-text.ts
  packages/web/src/lib/hub-job-steps.ts
  packages/web/src/components/RollingProgress.tsx
)
# Import / re-export lines name modules and types, they do not run anything: never matched.
IMPORT_RE='^[[:space:]]*(import[[:space:]]|export[[:space:]]+(type[[:space:]]+)?(\*|\{[^}]*\})[[:space:]]+from[[:space:]]|\}[[:space:]]+from[[:space:]])'

reasons=()
notes=()
cur=""
in_hunk=0
CTX=20            # context lines kept on each side of a change
HEAD_KEEP=3       # leading hunk lines always matched (the enclosing function signature)
# Signature-like lines (function / method / class / arrow const / shell function). The latest one seen
# in the hunk is matched with every change, so a doc comment above the function or a second function
# merged into the same hunk cannot push the enclosing signature out of the window.
# One-line forms: function / class / method / const arrow. Property arrows are SIG_PROP_RE below;
# signatures whose parameters span several lines are SIG_HEAD_RE (head) + SIG_CLOSE (closing line).
SIG_RE='^[[:space:]]*((export|async|public|private|protected|static|readonly|default|override)[[:space:]]+)*(function[[:space:]*]|class[[:space:]]|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*(<[^>]*>)?\(.*\)[^;]*\{[[:space:]]*$|(const|let)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=.*=>)|^[A-Za-z_][A-Za-z0-9_-]*[[:space:]]*\(\)[[:space:]]*\{'
# Object / class property holding a function: `handler: async (req) => {`, `run = (x) => {`,
# `onEnd: function () {`. The name is what the content rules look for, so the line must be kept.
SIG_PROP_RE='^[[:space:]]*([A-Za-z_$][A-Za-z0-9_$]*|"[^"]+"|'"'"'[^'"'"']+'"'"'|\[[^]]+\])[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(\([^)]*\)[[:space:]]*=>|function[[:space:]*]|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=>)'
# Head of a multi-line signature: a name followed by an unclosed `(`. A multi-line call looks the same,
# so a head is only kept once a closing line `) {` / `): T {` / `) =>` shows up before any `;`.
SIG_HEAD_RE='^[[:space:]]*((export|async|public|private|protected|static|readonly|default|override)[[:space:]]+)*(function[[:space:]*][A-Za-z_$]|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*(<[^>]*>)?\([^)]*$|[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?\([^)]*$)'
# A multi-line call ends on `;`. A semicolon inside the parameter list (`opts: { a: T; b: U }`) does not.
SEMI_END_RE=';[[:space:]]*$'
SIG_CLOSE_RE='^[[:space:]]*(\}[^)]*)?\)'
NOT_SIG_RE='^[[:space:]]*(if|for|while|switch|catch|else|return|do|await|new)([[:space:]]|\(|$)'
pending_head=""   # unclosed multi-line head awaiting its closing line
delta=()          # signature-like lines seen since the last change in the current hunk
hit_sigs=()       # signatures seen up to each change: all of them are matched when the hunk flushes
head_left=0
old_left=0
new_left=0
hunk=""           # text matched for the current hunk: function header + changes + nearby context
hunk_changed=0
pre=()            # trailing context lines seen since the last change (at most CTX)
after=0           # context lines still to keep after the last change

check_path() {
  [[ -n "$1" && "$1" != "$SELF" ]] || return 0
  [[ "$1" != *.md ]] && grep -Eiq "$PATH_RE" <<< "$1" && reasons+=("路径: $1")
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

# Match the finished hunk against the content rules. Here-strings, not `printf | grep -q`:
# under pipefail an early-exiting grep SIGPIPEs the writer on large hunks and the match is lost.
flush_hunk() {
  if (( hunk_changed )) && [[ -n "$cur" && "$cur" != "$SELF" ]] && content_scanned "$cur"; then
    # Every signature in the hunk participates: a change deep inside a second function (or inside a
    # callback that itself has a signature) must still see all enclosing names.
    if (( ${#hit_sigs[@]} )); then hunk="$(printf '%s\n' "${hit_sigs[@]}")"$'\n'"$hunk"; fi
    local pair label re text display=0 f
    for f in "${DISPLAY_ONLY[@]}"; do [[ "$cur" == "$f" ]] && display=1; done
    text="$(grep -Ev "$IMPORT_RE" <<< "$hunk" || true)"
    for pair in "上传:$UPLOAD_RE" "清理/删除:$DELETE_RE" "ledger 状态转换:$LEDGER_RE"; do
      label="${pair%%:*}"; re="${pair#*:}"
      if grep -Eiq "$re" <<< "$text"; then
        if (( display )); then notes+=("提示[$label](仅展示,不计 RISK): $cur")
        else reasons+=("内容[$label]: $cur"); fi
      fi
    done
  fi
  hunk=""
  hunk_changed=0
  pre=()
  after=0
  delta=()
  hit_sigs=()
}

# `diff --git a/X b/Y` (optionally quoted): the only header present for mode-only and binary changes.
header_paths() {
  local h="${1#diff --git }"
  h="${h//\"/}"
  local n=$(( (${#h} - 5) / 2 ))
  if (( n > 0 )) && [[ "${h:0:2}" == "a/" && "${h:2+n:3}" == " b/" && "${h:2:n}" == "${h:5+n}" ]]; then
    check_path "${h:2:n}"   # same path on both sides: split at the midpoint (paths may contain " b/")
    cur="${h:2:n}"
  elif [[ "$h" =~ ^a/(.*)\ b/(.*)$ ]]; then
    check_path "${BASH_REMATCH[1]}"
    [[ "${BASH_REMATCH[2]}" != "${BASH_REMATCH[1]}" ]] && check_path "${BASH_REMATCH[2]}"
    cur="${BASH_REMATCH[2]}"
  fi
  return 0
}

# Start a hunk: remember its line budget so plain `diff -u` input (no `diff --git` lines) still
# leaves the hunk at the right place, and keep the header's function name.
start_hunk() {
  in_hunk=1
  hunk="${1#@@*@@}"$'\n'
  head_left=$HEAD_KEEP
  pending_head=""
  delta=()
  hit_sigs=()
  old_left=1; new_left=1
  if [[ "$1" =~ ^@@\ -[0-9]+(,([0-9]+))?\ \+[0-9]+(,([0-9]+))?\ @@ ]]; then
    old_left="${BASH_REMATCH[2]:-1}"; new_left="${BASH_REMATCH[4]:-1}"
  fi
}

# Account one body line against the hunk budget; leave the hunk once both sides are consumed.
consume() {
  case "$1" in
    -) old_left=$((old_left - 1)) ;;
    +) new_left=$((new_left - 1)) ;;
    *) old_left=$((old_left - 1)); new_left=$((new_left - 1)) ;;
  esac
  if (( old_left <= 0 && new_left <= 0 )); then flush_hunk; in_hunk=0; fi
  return 0
}

while IFS= read -r line; do
  if (( in_hunk )); then
    case "$line" in
      "diff "*) flush_hunk; in_hunk=0; cur=""; header_paths "$line"; continue ;;
      "@@"*) flush_hunk; start_hunk "$line"; continue ;;
      "\\"*) continue ;;  # "\ No newline at end of file"
    esac
    body="${line:1}"
    sig_new=""
    if [[ ! "$body" =~ $NOT_SIG_RE ]]; then
      if [[ "$body" =~ $SIG_RE || "$body" =~ $SIG_PROP_RE ]]; then sig_new="$body"; pending_head=""
      elif [[ "$body" =~ $SIG_HEAD_RE ]]; then pending_head="$body"; fi
    fi
    # Closing line of a multi-line parameter list: commit the pending head as a signature.
    if [[ -n "$pending_head" && -z "$sig_new" && "$body" =~ $SIG_CLOSE_RE && ! "$body" =~ $SEMI_END_RE && "$body" =~ (\{|=>)[[:space:]]*$ ]]; then
      sig_new="$pending_head"; pending_head=""
    elif [[ "$body" =~ $SEMI_END_RE ]]; then pending_head=""; fi
    [[ -n "$sig_new" ]] && delta+=("$sig_new")
    # A change commits the signatures seen so far; signatures after the last change never join, so a
    # class-sized hunk cannot push the enclosing signature out (no cap needed for correctness).
    if [[ "$line" == [+-]* && ${#delta[@]} -gt 0 ]]; then hit_sigs+=("${delta[@]}"); delta=(); fi
    if (( head_left > 0 )); then
      # With --function-context the hunk opens on the enclosing function's signature: always match it.
      hunk+="$body"$'\n'; head_left=$((head_left - 1))
      [[ "$line" == [+-]* ]] && { hunk_changed=1; after=$CTX; }
    else
      case "$line" in
        [+-]*)
          (( ${#pre[@]} )) && hunk+="$(printf '%s\n' "${pre[@]}")"$'\n'
          pre=(); hunk+="$body"$'\n'; hunk_changed=1; after=$CTX ;;
        *)
          if (( after > 0 )); then hunk+="$body"$'\n'; after=$((after - 1))
          else pre+=("$body"); (( ${#pre[@]} > CTX )) && pre=("${pre[@]:1}")
          fi ;;
      esac
    fi
    consume "${line:0:1}"
    continue
  fi
  case "$line" in
    "diff "*) cur=""; header_paths "$line" ;;
    "+++ /dev/null"*|"--- /dev/null"*) ;;
    # File headers: git (`b/x`), plain `diff -u` (`x<TAB>timestamp`, optional a/ b/ prefix).
    "+++ "*) p="${line#+++ }"; p="${p%%$'\t'*}"; cur="${p#b/}"; check_path "$cur" ;;
    "--- "*) p="${line#--- }"; p="${p%%$'\t'*}"; cur="${p#a/}"; check_path "$cur" ;;  # 删除文件时 +++ 是 /dev/null,靠这行拿路径
    "rename from "*) check_path "${line#rename from }" ;;
    "rename to "*) cur="${line#rename to }"; check_path "$cur" ;;
    "@@"*) start_hunk "$line" ;;
    # A change line outside any hunk means the counts were wrong or the diff was cut: fail closed.
    [+-]*) reasons+=("diff 格式异常(hunk 外的增删行): ${cur:-未知文件}") ;;
  esac
done <<< "$DIFF"
flush_hunk

if (( ${#reasons[@]} )); then
  echo "RISK"
  printf '%s\n' "${reasons[@]}" | sort -u
  (( ${#notes[@]} )) && printf '%s\n' "${notes[@]}" | sort -u
  exit 1
fi
echo "PASS"
if (( ${#notes[@]} )); then printf '%s\n' "${notes[@]}" | sort -u; fi
