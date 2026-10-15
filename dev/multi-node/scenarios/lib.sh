# dev 多节点场景公共库(issue #88)。只由 `scripts/e2e-verify.sh run …` source:
# 此时隔离断言已过,下面所有 docker 操作都走 e2e-verify 的 dk_mut(同一道闸),
# 容器名只由 $CTRL/$NODE1/$NODE2 解析(DREC_DEV_SUFFIX 已体现),绝不出现写死的容器名。
# bash 3.2 兼容(无关联数组/mapfile)。场景里不开 errexit:断言失败要记账、继续跑完,最后由 sc_summary 统一出退出码。

SC_PASS=0
SC_FAIL=0
SC_ID=""
API_CODE=""
API_BODY=""

# ---------- 输出 / 断言 ----------
sc_begin() { SC_ID=$1; printf '\n== %s %s\n' "$1" "${2:-}"; }
sc_info()  { printf '       » %s\n' "$*"; }
sc_pass()  { SC_PASS=$((SC_PASS + 1)); printf 'PASS   [%s] %s\n' "$SC_ID" "$*"; }
sc_fail()  { SC_FAIL=$((SC_FAIL + 1)); printf 'FAIL   [%s] %s\n' "$SC_ID" "$*"; }

# expect_eq <路> <描述> <实际> <期望>
expect_eq() {
  if [[ $3 == "$4" ]]; then sc_pass "$1: $2(=$3)"; else sc_fail "$1: $2(实际 '$3',期望 '$4')"; fi
}
# expect_true <路> <描述> <命令…>:命令返回 0 即通过
expect_true() {
  local path=$1 desc=$2; shift 2
  if "$@" >/dev/null 2>&1; then sc_pass "$path: $desc"; else sc_fail "$path: $desc"; fi
}

sc_summary() {
  printf '\n== 场景汇总: PASS=%s FAIL=%s\n' "$SC_PASS" "$SC_FAIL"
  [[ $SC_FAIL -eq 0 ]] || { say "run: FAIL"; exit 1; }
  say "run: ALL PASS"
}

# ---------- 容器入口(全部经 dk_mut)----------
node_name() {
  case $1 in
    1) echo "$NODE1" ;;
    2) echo "$NODE2" ;;
    *) die "节点序号必须是 1|2(得 '$1')" ;;
  esac
}
cx() { dk_mut exec "$CTRL" "$@"; }
nx() { local n=$1; shift; dk_mut exec "$(node_name "$n")" "$@"; }
# 故障注入:只允许对 worker 容器做 stop/start/pause/unpause,对象名过命名断言。
fault() {
  case $1 in stop|start|pause|unpause) ;; *) die "fault 动词非法: $1" ;; esac
  local n; n=$(node_name "$2")
  chk_container_name "$n" || die "fault 目标不是 dev 容器: $n"
  [[ $n != "$CTRL" ]] || die "fault 不得作用于 controller"
  dk_mut "$1" "$n" >/dev/null
}
ctrl_logs() { dk_mut logs "$CTRL" 2>&1; }

# ---------- API(controller / worker 内部 curl;internal 网络无端口映射)----------
_curl() { # _curl <ctrl|node-N> METHOD PATH [JSON] → API_CODE/API_BODY
  local who=$1 m=$2 p=$3 d=${4:-} out args
  args=(curl -s -m 30 -X "$m" -w '\n%{http_code}')
  [[ -z $d ]] || args+=(-H 'content-type: application/json' -d "$d")
  args+=("http://localhost:7860$p")
  if [[ $who == ctrl ]]; then out=$(cx "${args[@]}"); else out=$(nx "${who#node-}" "${args[@]}"); fi
  API_CODE=${out##*$'\n'}
  API_BODY=${out%$'\n'*}
}
api()  { _curl ctrl "$@"; }
napi() { local n=$1; shift; _curl "node-$n" "$@"; }

# 台账(controller 的 sync 库,只读)→ JSON 数组
ledger() {
  cx node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/output-data/db/douyin-rec-sync.db",{readOnly:true});console.log(JSON.stringify(d.prepare(process.argv[1]).all()))' "$1"
}

# wait_for <超时秒> <命令…>:每 5s 轮询到命令返回 0;超时返回 1
wait_for() {
  local to=$1; shift
  local t0=$SECONDS
  while ! "$@" >/dev/null 2>&1; do
    [[ $((SECONDS - t0)) -lt $to ]] || return 1
    sleep 5
  done
}

# ---------- 播种 / 规则 ----------
# 对账周期(controller 的 hub.config.json 现读);场景里的等待时长按它换算
recon_ms() { cx node -e 'console.log(require("/output-data/config/hub.config.json").reconcileIntervalMs||1800000)'; }

# seed <节点 1|2> <anchor> <roomSlug> <endEpoch> [段数=2] [每段秒=20] [gapSec=0]
# 真 .ts(ffmpeg lavfi testsrc,video-only)+ session.json + xml。mtime=该段 endMs(节点扫描跑真 ffprobe 读时长)。
# 所有节点共用同一个 endEpoch → 同一场(起止一致)。
seed() {
  local n=$1 anchor=$2 room=$3 end=$4 segs=${5:-2} seg=${6:-20} gap=${7:-0}
  nx "$n" sh -c '
    set -e
    ANCHOR=$1; ROOM=$2; END=$3; SEGS=$4; SEG=$5; GAP=$6
    D=/output-data/recordings/$ANCHOR; mkdir -p "$D"
    START=$(( END - SEGS*SEG ))
    B=${ANCHOR}_$(date -d @$START +%Y-%m-%d_%H-%M-%S)
    i=0
    while [ $i -lt $SEGS ]; do
      F=$D/${B}_$(printf %03d $i).ts
      ffmpeg -v error -y -f lavfi -i testsrc=duration=$SEG:size=320x180:rate=15 -an \
             -c:v libx264 -pix_fmt yuv420p -f mpegts "$F"
      touch -d @$(( START + (i+1)*SEG )) "$F"
      i=$((i+1))
    done
    printf "{\"roomSlug\":\"%s\",\"platform\":\"douyin\",\"gaps\":[],\"totalGapSec\":%s,\"title\":\"dev-title\"}\n" "$ROOM" "$GAP" > "$D/$B.session.json"
    printf "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<i>\n<d p=\"1,1,25,16777215,1700000000,0,1,0\" user=\"u1\">dev</d>\n</i>\n" > "$D/$B.xml"
  ' _ "$anchor" "$room" "$end" "$segs" "$seg" "$gap"
}

# mk_task <roomSlug> <name> → stdout: 任务 id。
# 节点只会物化 enabled:true 的受管任务(task-sync:enabled:false 只更新已有、不新建),所以源任务必须启用;
# 为不让 daemon 去取流,给它一个「现在 +12h」的 1 分钟调度窗口(时区 Asia/Shanghai,与 serve 默认一致)。
mk_task() {
  local ws we
  ws=$(cx sh -c "TZ=Asia/Shanghai date -d '+12 hours' +%H:%M")
  we=$(cx sh -c "TZ=Asia/Shanghai date -d '+12 hours 1 minute' +%H:%M")
  api POST /api/tasks "{\"room\":\"https://live.douyin.com/$1\",\"name\":\"$2\",\"schedule\":\"$ws-$we\"}"
  [[ $API_CODE == 201 ]] || die "建任务失败 HTTP $API_CODE: $API_BODY"
  local id; id=$(printf '%s' "$API_BODY" | jq -r .id)
  api POST "/api/tasks/$id/start"   # 置 enabled=true;窗口外 → 不会真起录制子进程
  [[ $API_CODE == 200 ]] || die "启用任务失败 HTTP $API_CODE: $API_BODY"
  printf '%s' "$id"
}
# mk_rule <taskId> <workers JSON 数组> <pipeline JSON> → 规则 key 写到 stdout
mk_rule() {
  api POST /api/hub/rules "{\"enabled\":true,\"workers\":$2,\"recording\":{\"sourceTaskId\":$1},\"pipeline\":$3}"
  [[ $API_CODE == 201 ]] || die "建规则失败 HTTP $API_CODE: $API_BODY"
  printf '%s' "$API_BODY" | jq -r .key
}

# 清掉本场景的假房间:规则(连带台账历史)→ 任务 → 各节点播种目录 → controller stage 残留。
# 只动场景自己的锚点/9000100 开头房间号;都是 dev 数据根内的合成文件,非真实录像。
sc_cleanup_room() { # sc_cleanup_room <roomSlug> <anchor>
  local room=$1 anchor=$2 id n
  api DELETE "/api/hub/rules/douyin.$room" >/dev/null
  api GET /api/tasks
  for id in $(printf '%s' "$API_BODY" | jq -r --arg r "/$room" '.[]|select(.room|endswith($r))|.id'); do
    api DELETE "/api/tasks/$id" >/dev/null
  done
  for n in 1 2; do nx "$n" rm -rf "/output-data/recordings/$anchor" >/dev/null 2>&1; done
  cx rm -rf "/output-data/recordings/$anchor" >/dev/null 2>&1
  cx sh -c "rm -rf /output-data/stage/*$room* /output-data/stage/*$anchor* 2>/dev/null; true"
}

# 受管任务在某 worker 上的视图(按 roomSlug 找):stdout=JSON 对象或空
node_task() { # node_task <n> <roomSlug>
  napi "$1" GET /api/tasks
  printf '%s' "$API_BODY" | jq -c --arg r "/$2" '[.[]|select(.room|endswith($r))][0] // empty'
}
job_state() { # job_state <roomSlug> → 该房间最新 job 的 state(无则空)
  ledger "SELECT state FROM sync_jobs WHERE streamKey LIKE 'douyin:$1:%' ORDER BY updatedAt DESC LIMIT 1" | jq -r '.[0].state // empty'
}
job_count() { ledger "SELECT COUNT(*) AS n FROM sync_jobs WHERE streamKey LIKE 'douyin:$1:%'" | jq -r '.[0].n'; }

# 前端同一判定(web/src/lib/assigned.ts isUnassignedHidden)在 API 数据上的复刻,用来断言「默认被隐藏」
HIDDEN_JQ='.managedBy=="hub" and .assigned==false and (.recording|not) and (.running|not)'

# 前置:对账周期要够短,否则场景等不起(模板默认 15s;老环境需手改并 keep+up 重启 controller)
sc_require_fast_reconcile() {
  local ms; ms=$(recon_ms)
  if [[ $ms -gt 30000 ]]; then
    die "controller 的 reconcileIntervalMs=${ms}ms 太长。按 docs/dev-multi-node.md §8.0 改成 15000 后 keep+up 重启 controller"
  fi
  sc_info "reconcileIntervalMs=${ms}ms"
}
