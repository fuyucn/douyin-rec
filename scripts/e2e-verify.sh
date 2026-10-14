#!/usr/bin/env bash
# dev 多节点 e2e 环境控制脚本(issue #82)。设计与场景见 docs/dev-multi-node.md。
#
#   scripts/e2e-verify.sh up       # 隔离断言 → 建 dev 镜像 → 起 controller + 2 worker(drec-devnet internal)
#   scripts/e2e-verify.sh down     # 隔离断言 → 拆容器/网络,并清空 dev 数据(保留 dev 密钥)
#   scripts/e2e-verify.sh keep     # 隔离断言 → 只 stop 容器,保留数据与网络(事后排查;再 up 可续)
#   scripts/e2e-verify.sh doctor   # 只跑隔离断言(+反例自检),不起任何容器
#   scripts/e2e-verify.sh smoke    # 只读冒烟:controller 内 ssh 到 worker 跑无副作用命令 + 证明断外网
#
# 硬规矩:
#   - 任何 docker 操作前先跑隔离断言(GATE);dc()/dk_mut() 在断言未过时直接拒绝。
#   - 绝不执行不带 -p 的 docker compose;绝不 ssh 到线上主机(ssh 只发生在 controller 容器内、目标只能是 dev 容器名)。
#   - 可选 DREC_DEV_SUFFIX(如 -t1):与已存在的 drec-dev 并存时用,容器/网络/数据目录随之加后缀。
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
SUFFIX=${DREC_DEV_SUFFIX:-}
PROJECT="drec-dev-e2e${SUFFIX}"
CTRL="drec-dev${SUFFIX}"
NODE1="${CTRL}-node-1"
NODE2="${CTRL}-node-2"
NET="drec-devnet${SUFFIX}"
BASE_TAG="drec-dev-base:local${SUFFIX}"
NODE_TAG="drec-dev-node:local${SUFFIX}"
E2E_ROOT=${DREC_DEV_ROOT:-"$REPO/data-dev/e2e${SUFFIX}"}
COMPOSE_FILE="$REPO/dev/multi-node/compose.yml"
HUB_TEMPLATE="$REPO/dev/multi-node/hub.config.dev.json"
# 线上容器名:只允许对它们做只读 docker inspect(取挂载源以断言不重叠),绝不做其它操作。
PROD_CONTAINERS=(douyin-rec drec-tailscale)

GATE_A=0   # 静态断言(纯宿主机)已过
GATE_OK=0  # 含 docker 只读断言,允许 docker 变更操作
FAILS=0

# bash 3.2(macOS 自带)没有 mapfile:按行读进数组。用法 read_lines 数组名 < <(命令)
read_lines() { local _l; eval "$1=()"; while IFS= read -r _l; do [[ -z $_l ]] || eval "$1+=(\"\$_l\")"; done; }

say()  { printf '%s\n' "$*"; }
pass() { printf 'PASS   %s\n' "$*"; }
note() { printf 'NOTE   %s\n' "$*"; }
refuse() { printf 'REFUSE %s\n' "$*" >&2; return 1; }
die()  { printf 'ERROR  %s\n' "$*" >&2; exit 1; }

# ---------- 路径工具 ----------
# 规范化(含尚不存在的路径):最近的已存在祖先 realpath + 其余词法拼接。调用方先拒绝含 `..` 的输入。
canon() {
  local p=$1 tail=""
  while [[ ! -e $p ]]; do tail="/$(basename "$p")$tail"; p=$(dirname "$p"); done
  printf '%s%s\n' "$(cd "$p" && pwd -P)" "$tail"
}
# a 与 b 相等或互为父子 → 返回 0(重叠)
overlaps() {
  local a=${1%/} b=${2%/}
  [[ $a == "$b" || $a == "$b"/* || $b == "$a"/* ]]
}

# ---------- 断言原语(纯函数,doctor 的反例自检也走它们)----------
chk_suffix() {
  [[ -z $1 || ( $1 =~ ^-[a-z][a-z0-9]{0,11}$ && $1 != -node ) ]] || refuse "DREC_DEV_SUFFIX 非法: '$1'(须形如 -t1,且不能是 -node)"
}
chk_container_name() {
  local n=$1
  [[ $n != drec-dev-node ]] && [[ $n =~ ^drec-dev(-[a-z][a-z0-9]{0,11})?(-node-[0-9]+)?$ ]] \
    || refuse "容器名 '$n' 不匹配 ^drec-dev(-后缀)?(-node-N)?\$"
}
chk_network_name() {
  [[ $1 =~ ^drec-devnet(-[a-z][a-z0-9]{0,11})?$ ]] || refuse "网络名 '$1' 不匹配 ^drec-devnet(-后缀)?\$"
}
chk_project_name() {
  [[ $1 =~ ^drec-dev-e2e(-[a-z][a-z0-9]{0,11})?$ ]] || refuse "compose 项目名 '$1' 不匹配 ^drec-dev-e2e(-后缀)?\$"
}
chk_image_tag() {
  [[ $1 =~ ^drec-dev-(base|node):local(-[a-z][a-z0-9]{0,11})?$ ]] || refuse "镜像标签 '$1' 不是 drec-dev-(base|node):local*"
}
# 数据根:绝对路径、无 `..`、路径含 /data-dev/
chk_data_path() {
  local p=$1
  [[ $p == /* ]] || { refuse "数据根必须是绝对路径: $p"; return 1; }
  [[ $p != *..* ]] || { refuse "数据根含 '..': $p"; return 1; }
  [[ $p == */data-dev/* ]] || { refuse "数据根 '$p' 不含 data-dev/ 前缀段"; return 1; }
}
# $1 = dev 根,其余 = 线上数据根候选:不得相等/互为父子
chk_no_overlap() {
  local dev; dev=$(canon "$1"); shift
  local prod c
  for prod in "$@"; do
    [[ -n $prod ]] || continue
    c=$(canon "$prod")
    if overlaps "$dev" "$c"; then refuse "dev 数据根 '$dev' 与线上数据根 '$c' 相等或互为父子"; return 1; fi
  done
}
# workers[].host 只能是本环境 dev 容器名;线上形态(IPv4 / *.ts.net / 其它名)一律拒绝
chk_host() {
  [[ $1 =~ ^${CTRL}-node-[0-9]+$ ]] || refuse "worker host '$1' 不是 dev 容器名(${CTRL}-node-N);疑似线上形态"
}
chk_hub_config() {
  local f=$1 h bad=0
  [[ -f $f ]] || { refuse "hub 配置不存在: $f"; return 1; }
  jq -e '.workers | type == "array"' "$f" >/dev/null 2>&1 || { refuse "hub 配置 workers 不是数组: $f"; return 1; }
  if grep -Eq '([0-9]{1,3}\.){3}[0-9]{1,3}|\.ts\.net' "$f"; then refuse "hub 配置含 IPv4/ts.net 形态字符串: $f"; return 1; fi
  while IFS='|' read -r kind host root; do
    case $kind in local) ;; ssh|tailscale-ssh) chk_host "$host" || bad=1 ;; *) refuse "未知 worker kind: $kind"; bad=1 ;; esac
    [[ $root == /output-data ]] || { refuse "worker dataRoot 必须是 /output-data(得 '$root')"; bad=1; }
  done < <(jq -r '.workers[] | [.kind, (.host // ""), (.dataRoot // "")] | join("|")' "$f")
  [[ ${bad:-0} -eq 0 ]]
}
fp_of() { ssh-keygen -lf "$1" 2>/dev/null | awk '{print $2}'; }
# $1 = dev 私钥,其余 = 线上/个人私钥候选:指纹不得相同
chk_key_fp() {
  local dev; dev=$(fp_of "$1") || true
  [[ -n $dev ]] || { refuse "读不到 dev 密钥指纹: $1"; return 1; }
  local k fp
  shift
  for k in "$@"; do
    [[ -f $k ]] || continue
    fp=$(fp_of "$k") || true
    [[ -n $fp ]] || continue
    [[ $fp != "$dev" ]] || { refuse "dev 密钥指纹与 '$k' 相同($dev)"; return 1; }
  done
}
# dev 数据根内不得有真实凭证:禁用文件名;cookies.json 必须含 FAKE-DEV 标记。keys/ 下只允许 dev 密钥对。
chk_no_creds() {
  local root=$1 bad=0 f
  [[ -d $root ]] || return 0
  while IFS= read -r f; do
    case $f in
      "$root/keys/dev_ed25519"|"$root/keys/dev_ed25519.pub") ;;
      *) refuse "dev 数据根含疑似凭证文件: $f"; bad=1 ;;
    esac
  done < <(find "$root" \( -name 'vps.key' -o -name '*.pem' -o -name '.env' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name 'id_ecdsa*' -o -name 'config.yaml' -o -name '*.cookies' -o -path "$root/keys/*" \) -type f 2>/dev/null)
  while IFS= read -r f; do
    grep -q 'FAKE-DEV' "$f" || { refuse "cookies.json 不含 FAKE-DEV 标记(疑似真凭证): $f"; bad=1; }
  done < <(find "$root" -name 'cookies.json' -type f 2>/dev/null)
  [[ $bad -eq 0 ]]
}
chk_internal() { [[ $1 == true ]] || refuse "网络 $NET 不是 internal(Internal=$1)"; }

# 渲染后的 compose 配置(JSON on stdin)静态断言
chk_compose_json() {
  local json; json=$(cat)
  local out
  out=$(jq -r --arg root "$E2E_ROOT" --arg net "$NET" '
    [ (.services | to_entries[] | .value as $s | .key as $k |
        (if ($s.ports // []) | length > 0 then "\($k): 不得 publish 端口" else empty end),
        (if $s.network_mode then "\($k): 不得设置 network_mode" else empty end),
        (if $s.privileged == true then "\($k): 不得 privileged" else empty end),
        (if $s.pid then "\($k): 不得设置 pid" else empty end),
        (if ($s.networks // {} | keys) != ["drec-devnet"] then "\($k): networks 必须恰为 [drec-devnet]" else empty end),
        (($s.volumes // [])[] | select(.type != "bind" or ((.source | startswith($root + "/")) | not)) | "\($k): 挂载源不在 dev 数据根: \(.source)"),
        (($s.volumes // [])[] | select(.source | test("docker-data|vps\\.key")) | "\($k): 挂载源疑似线上: \(.source)")
      ),
      (if .networks["drec-devnet"].internal != true then "网络 \($net) 未声明 internal:true" else empty end),
      (if .networks["drec-devnet"].name != $net then "网络名不是 \($net)" else empty end)
    ] | .[]' <<<"$json") || { refuse "compose 渲染结果无法解析"; return 1; }
  if [[ -n $out ]]; then while IFS= read -r l; do refuse "compose: $l"; done <<<"$out"; return 1; fi
}

# ---------- 阶段 A:纯宿主机静态断言(不碰 docker)----------
prod_root_candidates() {
  local common main
  echo "$REPO/docker-data"
  common=$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || true)
  if [[ -n $common ]]; then
    main=$(cd "$REPO" && cd "$(dirname "$(cd "$common" && pwd -P)")" && pwd -P)
    echo "$main/docker-data"
    [[ -f $main/.env ]] && grep -E '^DATA_ROOT=' "$main/.env" | tail -1 | cut -d= -f2- | sed "s#^\./#$main/#" || true
  fi
  [[ -f $REPO/.env ]] && grep -E '^DATA_ROOT=' "$REPO/.env" | tail -1 | cut -d= -f2- | sed "s#^\./#$REPO/#" || true
}
prod_key_candidates() {
  local common main f
  echo "$REPO/remote/vps.key"
  common=$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null || true)
  if [[ -n $common ]]; then
    main=$(dirname "$(cd "$common" && pwd -P)"); echo "$main/remote/vps.key"
  fi
  for f in "$HOME"/.ssh/id_* ; do [[ $f == *.pub ]] || echo "$f"; done
}

stage_a() {
  say "== 阶段 A:静态隔离断言(宿主机,未碰 docker)"
  local rc=0
  need() { command -v "$1" >/dev/null 2>&1 || { refuse "缺少依赖命令: $1"; rc=1; }; }
  need jq; need ssh-keygen; need docker
  [[ $rc -eq 0 ]] || return 1
  chk_suffix "$SUFFIX" && pass "后缀合法 '${SUFFIX:-<无>}'" || rc=1
  chk_project_name "$PROJECT" && pass "compose 项目名 $PROJECT" || rc=1
  for n in "$CTRL" "$NODE1" "$NODE2"; do chk_container_name "$n" && pass "容器名 $n" || rc=1; done
  chk_network_name "$NET" && pass "网络名 $NET" || rc=1
  chk_image_tag "$BASE_TAG" && chk_image_tag "$NODE_TAG" && pass "镜像标签 $BASE_TAG / $NODE_TAG" || rc=1
  chk_data_path "$E2E_ROOT" && pass "数据根含 data-dev/: $E2E_ROOT" || rc=1
  [[ $rc -eq 0 ]] || return 1
  local -a prods; read_lines prods < <(prod_root_candidates)
  chk_no_overlap "$E2E_ROOT" "${prods[@]}" && pass "dev 数据根与线上数据根不相等/不互为父子(候选 ${#prods[@]} 个)" || rc=1
  if [[ -f $E2E_ROOT/keys/dev_ed25519 ]]; then
    local -a keys; read_lines keys < <(prod_key_candidates)
    chk_key_fp "$E2E_ROOT/keys/dev_ed25519" "${keys[@]}" && pass "dev 密钥指纹 $(fp_of "$E2E_ROOT/keys/dev_ed25519") 与线上/个人密钥均不同" || rc=1
  else
    note "dev 密钥尚未生成(up 时生成并复检)"
  fi
  local hub="$E2E_ROOT/controller/config/hub.config.json"
  if [[ -f $hub ]]; then
    chk_hub_config "$hub" && pass "hub 配置 workers[].host 均为 dev 容器名: $hub" || rc=1
  else
    # 数据根尚未初始化:校验模板(渲染后的占位符换成本环境容器名)。
    local tmp; tmp=$(mktemp)
    sed -e "s#__NODE1__#$NODE1#" -e "s#__NODE2__#$NODE2#" "$HUB_TEMPLATE" >"$tmp"
    chk_hub_config "$tmp" && pass "hub 配置模板渲染后 host 均为 dev 容器名" || rc=1
    rm -f "$tmp"
  fi
  chk_no_creds "$E2E_ROOT" && pass "dev 数据根内无真实凭证文件" || rc=1
  [[ $rc -eq 0 ]] || return 1
  GATE_A=1
}

# ---------- 阶段 B:docker 只读断言(要求 A 已过;仍不做任何变更)----------
dk_read() { [[ $GATE_A -eq 1 ]] || die "内部错误:静态断言未过却调用 docker"; docker "$@"; }
dk_mut()  { [[ $GATE_OK -eq 1 ]] || die "内部错误:隔离断言未过却调用 docker 变更操作"; docker "$@"; }
dc() {
  [[ $GATE_OK -eq 1 ]] || die "内部错误:隔离断言未过却调用 docker compose"
  [[ -n $PROJECT ]] || die "内部错误:compose 项目名为空(绝不执行不带 -p 的 compose)"
  E2E_ROOT="$E2E_ROOT" DREC_DEV_SUFFIX="$SUFFIX" docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

stage_b() {
  say "== 阶段 B:docker 只读断言"
  local rc=0
  if ! dk_read info >/dev/null 2>&1; then refuse "docker daemon 不可达"; return 1; fi
  # 线上容器的数据根挂载:dev 根不得与其重叠;线上 SSH 密钥(若挂载)指纹不得与 dev 密钥相同。
  local pc src
  for pc in "${PROD_CONTAINERS[@]}"; do
    if dk_read inspect "$pc" >/dev/null 2>&1; then
      while IFS=$'\t' read -r dest src; do
        [[ -n $src && -e $src ]] || continue
        case $dest in
          /output-data) chk_no_overlap "$E2E_ROOT" "$src" && pass "与线上容器 $pc 的数据根($dest)不重叠" || rc=1 ;;
          /root/.ssh/vps.key)
            if [[ -f $E2E_ROOT/keys/dev_ed25519 ]]; then
              chk_key_fp "$E2E_ROOT/keys/dev_ed25519" "$src" && pass "dev 密钥 != 线上容器 $pc 挂载的 vps.key" || rc=1
            fi ;;
        esac
      done < <(dk_read inspect "$pc" --format '{{range .Mounts}}{{.Destination}}{{"\t"}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null)
    else
      note "线上容器 $pc 本机不存在,跳过其挂载比对(静态候选已比对)"
    fi
  done
  # 同名容器必须属于本项目,否则拒绝(避免覆盖别人的 drec-dev)
  local n owner
  for n in "$CTRL" "$NODE1" "$NODE2"; do
    if dk_read inspect "$n" >/dev/null 2>&1; then
      owner=$(dk_read inspect "$n" --format '{{index .Config.Labels "com.docker.compose.project"}}')
      if [[ $owner == "$PROJECT" ]]; then pass "容器 $n 已存在且属于本项目"
      else refuse "容器 $n 已存在但不属于本项目(project='$owner')。用 DREC_DEV_SUFFIX=-t1 并存,或先自行处理旧容器"; rc=1; fi
    fi
  done
  # 网络已存在则必须 internal
  if dk_read network inspect "$NET" >/dev/null 2>&1; then
    chk_internal "$(dk_read network inspect "$NET" --format '{{.Internal}}')" && pass "已存在网络 $NET internal=true" || rc=1
  fi
  # 渲染后的 compose 静态断言
  local json
  if json=$(E2E_ROOT="$E2E_ROOT" DREC_DEV_SUFFIX="$SUFFIX" dk_read compose -p "$PROJECT" -f "$COMPOSE_FILE" config --format json 2>&1); then
    chk_compose_json <<<"$json" && pass "compose 渲染:无 ports/network_mode/privileged,仅接 $NET(internal),挂载全在 dev 数据根" || rc=1
  else
    refuse "docker compose config 失败: ${json:0:300}"; rc=1
  fi
  [[ $rc -eq 0 ]] || return 1
  GATE_OK=1
}

gate() { stage_a && stage_b; }

# ---------- 初始化 dev 数据根 ----------
prepare() {
  [[ $GATE_A -eq 1 ]] || die "内部错误:prepare 前须过静态断言"
  mkdir -p "$E2E_ROOT"/{controller,node-1,node-2}/recordings "$E2E_ROOT/controller/config" "$E2E_ROOT/keys"
  local d
  for d in controller node-1 node-2; do printf 'drec-dev-e2e\n' >"$E2E_ROOT/$d/.drec-dev-e2e"; done
  if [[ ! -f $E2E_ROOT/keys/dev_ed25519 ]]; then
    ssh-keygen -q -t ed25519 -N '' -C "drec-dev-e2e${SUFFIX}" -f "$E2E_ROOT/keys/dev_ed25519"
    note "已生成 dev 专用密钥 $E2E_ROOT/keys/dev_ed25519"
  fi
  chmod 600 "$E2E_ROOT/keys/dev_ed25519"
  local hub="$E2E_ROOT/controller/config/hub.config.json"
  if [[ ! -f $hub ]]; then
    sed -e "s#__NODE1__#$NODE1#" -e "s#__NODE2__#$NODE2#" "$HUB_TEMPLATE" >"$hub"
    note "已写入 hub 配置 $hub"
  fi
}

# ---------- 子命令 ----------
cmd_doctor() {
  gate || { say "doctor: FAIL(见上方 REFUSE)"; return 1; }
  negative_cases || return 1
  say "doctor: ALL PASS(隔离断言 + 反例自检);未起任何容器"
}

# 反例自检:每个断言喂入「线上形态」输入,必须被拒绝;拒绝=自检通过。证明断言不是摆设。
negative_cases() {
  say "== 反例自检(每条都必须被拒绝)"
  local rc=0 t
  expect_refuse() { # 描述 命令...
    local desc=$1; shift
    if "$@" 2>/tmp/.e2e-neg.$$; then printf 'FAIL   反例未被拒绝: %s\n' "$desc"; rc=1
    else printf 'REJECT %s  <- %s\n' "$desc" "$(head -1 /tmp/.e2e-neg.$$)"; fi
    rm -f /tmp/.e2e-neg.$$
  }
  expect_refuse "线上容器名 douyin-rec"       chk_container_name douyin-rec
  expect_refuse "线上容器名 drec-tailscale"   chk_container_name drec-tailscale
  expect_refuse "非法节点名 drec-dev-node-x"  chk_container_name drec-dev-node-x
  expect_refuse "线上网络名 video-screenshot_default" chk_network_name video-screenshot_default
  expect_refuse "无 data-dev 的数据根"        chk_data_path /srv/docker-data/e2e
  expect_refuse "含 .. 的数据根"              chk_data_path "$REPO/data-dev/../docker-data"
  t=$(mktemp -d)
  mkdir -p "$t/docker-data" "$t/docker-data/data-dev"
  expect_refuse "dev 根 == 线上根"            chk_no_overlap "$t/docker-data" "$t/docker-data"
  expect_refuse "dev 根是线上根的子目录"      chk_no_overlap "$t/docker-data/data-dev" "$t/docker-data"
  expect_refuse "dev 根是线上根的父目录"      chk_no_overlap "$t" "$t/docker-data"
  expect_refuse "worker host = IPv4(tailnet 形态)" chk_host 100.64.0.1  # issue-guard: allow(测试夹具:线上形态假值)
  expect_refuse "worker host = *.ts.net"      chk_host example-node.ts.net
  expect_refuse "worker host = 普通主机名"    chk_host some-vps
  printf '{"workers":[{"id":"x","kind":"tailscale-ssh","host":"100.64.0.1","dataRoot":"/output-data"}]}' >"$t/bad-hub.json"  # issue-guard: allow(测试夹具:线上形态假值)
  expect_refuse "hub 配置含线上形态 host"     chk_hub_config "$t/bad-hub.json"
  printf '{"workers":[{"id":"x","kind":"ssh","host":"%s","dataRoot":"/home/someone/drec"}]}' "$NODE1" >"$t/bad-root.json"  # issue-guard: allow(测试夹具:线上形态假值)
  expect_refuse "hub 配置 dataRoot 非 /output-data" chk_hub_config "$t/bad-root.json"
  ssh-keygen -q -t ed25519 -N '' -f "$t/k1"
  expect_refuse "dev 密钥指纹 == 线上密钥"    chk_key_fp "$t/k1" "$t/k1"
  mkdir -p "$t/root/keys" "$t/root/node-1/config/biliup"
  printf '{"cookie_info":{"cookies":[{"name":"SESSDATA","value":"realish"}]}}' >"$t/root/node-1/config/biliup/cookies.json"
  expect_refuse "数据根内有不含 FAKE-DEV 的 cookies.json" chk_no_creds "$t/root"
  rm "$t/root/node-1/config/biliup/cookies.json"; : >"$t/root/node-1/vps.key"
  expect_refuse "数据根内有 vps.key"          chk_no_creds "$t/root"
  expect_refuse "网络 internal=false"         chk_internal false
  printf '{"services":{"a":{"ports":[{"target":7860}],"networks":{"drec-devnet":null},"volumes":[]}},"networks":{"drec-devnet":{"internal":true,"name":"%s"}}}' "$NET" >"$t/c1.json"
  expect_refuse "compose 含 publish 端口"     chk_compose_json <"$t/c1.json"
  printf '{"services":{"a":{"networks":{"drec-devnet":null,"default":null},"volumes":[]}},"networks":{"drec-devnet":{"internal":false,"name":"%s"}}}' "$NET" >"$t/c2.json"
  expect_refuse "compose 多网络且 internal=false" chk_compose_json <"$t/c2.json"
  printf '{"services":{"a":{"networks":{"drec-devnet":null},"volumes":[{"type":"bind","source":"/srv/docker-data","target":"/output-data"}]}},"networks":{"drec-devnet":{"internal":true,"name":"%s"}}}' "$NET" >"$t/c3.json"
  expect_refuse "compose 挂载线上数据根"      chk_compose_json <"$t/c3.json"
  rm -rf "$t"
  [[ $rc -eq 0 ]] || { say "反例自检: FAIL"; return 1; }
  say "反例自检: 全部被拒绝"
}

cmd_up() {
  stage_a_pre_prepare
  gate
  say "== 构建镜像"
  # 基础镜像 = 生产 Dockerfile 的 worker 档(无 biliup/playwright/ssh)。tag 固定 drec-dev-base:local*,不覆盖线上镜像。
  dk_mut build --build-arg IMAGE_ROLE=worker --build-arg "GIT_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo)" -t "$BASE_TAG" "$REPO"
  dc build
  verify_image
  say "== 起容器"
  dc up -d
  post_up_assert
  say "up: OK。controller=$CTRL workers=$NODE1,$NODE2 网络=$NET(internal)"
  say "  看 API:  docker exec $CTRL curl -s http://localhost:7860/api/tasks"
  say "  冒烟:    DREC_DEV_SUFFIX='$SUFFIX' scripts/e2e-verify.sh smoke"
}

# up 需要先 A(以便 prepare 写数据根),prepare 之后 gate 会重新完整跑 A+B(含密钥/凭证复检)。
stage_a_pre_prepare() {
  say "== 预检(路径/名称)"
  chk_suffix "$SUFFIX"; chk_project_name "$PROJECT"; chk_data_path "$E2E_ROOT"
  chk_container_name "$CTRL"; chk_container_name "$NODE1"; chk_container_name "$NODE2"; chk_network_name "$NET"
  local -a prods; read_lines prods < <(prod_root_candidates)
  chk_no_overlap "$E2E_ROOT" "${prods[@]}"
  GATE_A=1; prepare; GATE_A=0
}

verify_image() {
  say "== 校验 dev 镜像不含真 biliup / 线上 ssh 材料"
  dk_mut run --rm --network none --entrypoint sh "$NODE_TAG" -c '
    set -e
    grep -q "fake-biliup" /usr/local/bin/biliup
    [ "$(find /usr /opt /root /app /home -name biliup -not -path /usr/local/bin/biliup 2>/dev/null | wc -l)" -eq 0 ]
    [ ! -e /root/.ssh/vps.key ]
    [ ! -d /root/.cache/ms-playwright ]
    echo image-ok' | grep -q image-ok || die "dev 镜像校验失败(含真 biliup / 线上材料 / 非 worker 档)"
  pass "dev 镜像:biliup 是假脚本、无真 biliup、无 vps.key、非 master 档"
}

post_up_assert() {
  local v
  v=$(dk_mut network inspect "$NET" --format '{{.Internal}}')
  if ! chk_internal "$v"; then
    dc down --remove-orphans || true
    die "起栈后发现网络非 internal,已拆除"
  fi
  pass "起栈后复检:网络 $NET internal=true"
  local n
  for n in "$CTRL" "$NODE1" "$NODE2"; do
    [[ $(dk_mut inspect "$n" --format '{{json .NetworkSettings.Networks}}' | jq -r 'keys | join(",")') == "$NET" ]] \
      && pass "容器 $n 仅接入 $NET" || { dc down --remove-orphans || true; die "容器 $n 网络不是仅 $NET,已拆除"; }
  done
}

cmd_down() {
  gate
  dc down --remove-orphans
  # 清空 dev 数据(保留 keys/):只删本脚本建的三个子目录,路径已过 chk_data_path。
  local d
  for d in controller node-1 node-2; do
    if [[ -f $E2E_ROOT/$d/.drec-dev-e2e ]]; then rm -rf "${E2E_ROOT:?}/$d"
    else note "跳过 $E2E_ROOT/$d(无 dev 标记或不存在)"; fi
  done
  say "down: OK(容器/网络已拆,dev 数据已清;dev 密钥保留在 $E2E_ROOT/keys)"
}

cmd_keep() {
  gate
  dc stop
  say "keep: OK(容器已 stop,数据与网络保留于 $E2E_ROOT;再 up 可续)"
}

cmd_smoke() {
  gate
  say "== 只读冒烟:$CTRL 内 ssh → worker(无副作用命令)"
  local n
  for n in "$NODE1" "$NODE2"; do
    say "--- $n"
    dk_mut exec "$CTRL" ssh -o BatchMode=yes -o ConnectTimeout=8 "$n" -- \
      'echo "host=$(hostname) user=$(id -un) tz=$(date +%Z)"; test -L /output-data/dist && echo "dist -> $(readlink /output-data/dist)"; biliup -V; node /output-data/dist/douyin-rec.mjs _node-capabilities /output-data'
  done
  say "--- 外网应不可达(internal 网络)"
  if dk_mut exec "$CTRL" curl -sS -m 4 -o /dev/null https://example.com 2>/tmp/.e2e-egress.$$; then
    rm -f /tmp/.e2e-egress.$$; die "controller 居然能访问外网!internal 网络失效"
  fi
  pass "controller 访问外网失败(预期): $(head -1 /tmp/.e2e-egress.$$)"; rm -f /tmp/.e2e-egress.$$
  say "smoke: OK"
}

case ${1:-} in
  up) cmd_up ;;
  down) cmd_down ;;
  keep) cmd_keep ;;
  doctor) cmd_doctor ;;
  smoke) cmd_smoke ;;
  *) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
