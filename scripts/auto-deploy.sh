#!/usr/bin/env bash
# auto-deploy.sh — 监听「录制空闲」，空闲即自动执行部署 + id 迁移。
#
# 硬性 guard(AGENTS.md)：任何重启前必须确认相关节点 `recording===true` 为 0。
# 本脚本每轮都重新检查；一旦发现有人在录，就继续等，绝不强推。
#
# 顺序(每步前重查 guard):
#   ① master 重建(docker)       —— master 不直接录,只需它自己 0 子进程
#   ② VPS2 装 swap(无 swap 才装) —— 不重启,零风险
#   ③ VPS1 补 fstab(swap 已存在) —— 只写文件,零风险
#   ④ VPS2 更新 bundle + 重启    —— 需 VPS2 0 在录
#   ⑤ VPS1 更新 bundle + 重启    —— 需 VPS1 0 在录(等开播安全)
#   ⑥ 迁移 id → nodeId           —— 需 master 就绪
#
# **分批 rollout**(--stage):VPS1 是唯一可能被打断的节点(有活跃录制),
# 故默认拆开跑,避免为了等 VPS1 把 master/VPS2 也一起拖住。
#   --stage first    master + swap + VPS2   (不碰 VPS1,随时可跑)
#   --stage vps1     仅 VPS1                (等它 0 在录)
#   --stage migrate  仅迁移 id → nodeId     (master 能读到 nodeId 即可)
#   --stage all      一次全做(默认;VPS1 不空闲则跳过该步)
#
# 用法: scripts/auto-deploy.sh [--stage first|vps1|migrate|all] [--max-min 120] [--dry]
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="docker-data"
POLL=60
MAX_MIN=180
DRY=0
STAGE="all"     # first=master+VPS2 | vps1=VPS1 | migrate=迁移 id | all=全做
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-min) MAX_MIN="$2"; shift 2 ;;
    --poll) POLL="$2"; shift 2 ;;
    --dry) DRY=1; shift ;;
    --stage) STAGE="$2"; shift 2 ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
LOG=/tmp/auto-deploy.log
ts() { date '+%H:%M:%S'; }
say() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# ── 录制状态查询(任一失败按「在录」保守处理) ────────────────────────────────
recording_of() {  # $1=local|vps1|vps2 → 输出 在录任务描述(空=空闲)
  case "$1" in
    local) docker exec douyin-rec sh -c 'curl -sS --max-time 6 http://127.0.0.1:7860/api/tasks' 2>/dev/null ;;
    vps1)  ssh -o ConnectTimeout=6 vps 'curl -sS --max-time 6 http://127.0.0.1:7860/api/tasks' 2>/dev/null ;;
    vps2)  ssh -o ConnectTimeout=6 video-rec-2 'curl -sS --max-time 6 http://127.0.0.1:7860/api/tasks' 2>/dev/null ;;
  esac | python3 -c "$(cat <<'PY'
import sys, json
try:
    data = json.load(sys.stdin)
    out = []
    for t in data:
        if t.get("recording"):
            out.append("%s:%s" % (t.get("id"), t.get("anchorName") or t.get("room")))
    print("|".join(out))
except Exception:
    print("UNKNOWN")   # 查不到 → 视为不可安全部署
PY
)"
}

wait_idle() { # $1=节点名 $2=最长等待秒 ; 空闲返回0
  local node="$1" maxs="$2" waited=0 r
  while [[ $waited -lt $maxs ]]; do
    r=$(recording_of "$node")
    if [[ -z "$r" ]]; then return 0; fi
    if [[ "$r" == "UNKNOWN" ]]; then
      say "  [$node] 状态查询失败 → 保守等待重试"
    else
      say "  [$node] 仍在录: $r → 等待"
    fi
    sleep "$POLL"; waited=$((waited+POLL))
  done
  return 1
}

MAXS=$((MAX_MIN*60))
say "=== 自动部署开始(最长等 ${MAX_MIN} 分钟;dry=$DRY) ==="

# 各步骤独立容错:某步等待超时 → 只跳过该步,继续后续能做的(否则「等 3 小时才空闲,
# 结果因最后一步超时把前面已完成的 master/VPS2 更新全丢」——踩过)。
FAILED=()   # 记录失败/跳过的步骤,最后汇总
note() { FAILED+=("$1"); }

# ── ① master 重建(它不直接录;只要容器内无录制子进程) ────────────────────────
say "① master:检查是否在录…"
if wait_idle local "$MAXS"; then
  say "  master 空闲 → 重建镜像"
  if [[ $DRY == 1 ]]; then say "  [dry] 跳过 docker compose up"; else
    if GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build >> "$LOG" 2>&1; then
      say "  ✓ master 已更新"; sleep 15
    else
      say "  ✗ master 重建失败(见 $LOG)"; note "master 重建失败"
    fi
  fi
else
  say "  ✗ master 等待超时 → 跳过(继续其余步骤)"; note "master 未更新(超时)"
fi

# ── ② VPS2 装 swap(不重启,零风险) ───────────────────────────────────────────
say "② VPS2:装 swap(若缺)"
if [[ $DRY == 1 ]]; then say "  [dry] 跳过 swap"; else
  ssh -o ConnectTimeout=8 video-rec-2 'bash -s' <<'EOS' 2>&1 | tee -a "$LOG"
set -e
if swapon --show | grep -q .; then echo "  已有 swap,跳过"; exit 0; fi
sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
sudo chmod 600 /swapfile
sudo mkswap /swapfile >/dev/null
sudo swapon /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf >/dev/null
sudo sysctl -p /etc/sysctl.d/99-swap.conf >/dev/null
echo "  ✓ swap 已启用:"; free -h | grep -i swap
EOS
fi

# ③ VPS1 补 fstab(只写文件,零风险:不影响运行中进程/录制)。抽成函数供 stage 调用。
fix_vps1_fstab() {
  say "③ VPS1:补 swap fstab(防重启丢 swap;只写文件,零风险)"
  if [[ $DRY == 1 ]]; then say "  [dry] 跳过 fstab"; return 0; fi
  ssh -o ConnectTimeout=8 vps 'bash -s' <<'EOS' 2>&1 | tee -a "$LOG"
if ! swapon --show | grep -q .; then echo "  ✗ VPS1 无活动 swap,需人工处理(跳过)"; exit 0; fi
if grep -q '^/swapfile' /etc/fstab; then echo "  fstab 已有 swap 条目,跳过"; exit 0; fi
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
echo "  ✓ 已加 fstab 条目(下次重启 swap 不丢)"
EOS
}

# 单节点更新 bundle(供 ④⑤ 共用)。$1=节点名(vps1|vps2) $2=ssh 目标
update_node() {
  local node="$1" target="$2"
  say "[$node] 更新 bundle"
  if wait_idle "$node" "$MAXS"; then
    if [[ $DRY == 1 ]]; then say "  [dry] 跳过"; return 0; fi
    scp -q dist/douyin-rec.mjs "$target":/tmp/drec-new.mjs \
      && ssh -o ConnectTimeout=10 "$target" 'sudo cp /tmp/drec-new.mjs /home/ubuntu/drec/dist/douyin-rec.mjs && sudo systemctl restart video-screenshot && sleep 3 && systemctl is-active video-screenshot && grep -c _node-id /home/ubuntu/drec/dist/douyin-rec.mjs' \
      && say "  ✓ $node 已更新" || { say "  ✗ $node 更新失败"; note "$node 未更新"; }
  else
    say "  ✗ $node 等待超时 → 跳过(不改动)"; note "$node 未更新(超时)"
  fi
}

# 迁移 id → nodeId(供 ⑥ 用)
migrate_ids() {
  say "⑥ 迁移 worker id → nodeId"
  sleep 5   # 等各节点 serve 就绪 + node.json 落盘
  if [[ $DRY == 1 ]]; then
    scripts/migrate-worker-ids.sh --root "$ROOT" 2>&1 | tee -a "$LOG"
  else
    scripts/migrate-worker-ids.sh --root "$ROOT" --apply 2>&1 | tee -a "$LOG" \
      && say "  ✓ 迁移完成(master 下个 sync tick 自动同步)" || note "id 迁移未完成"
  fi
}

# ── 分批 rollout ────────────────────────────────────────────────────────────
# 默认只做「不碰 VPS1 录制」的部分(master + VPS2 + swap)。VPS1 单独一批,
# 因为它是唯一可能被打断的节点(有活跃录制)。迁移 id 放最后(master 就绪即可)。
case "$STAGE" in
  first)   # 第一批:master + VPS2(+swap)。不碰 VPS1。
    update_node vps2 video-rec-2
    ;;
  vps1)    # 第二批:VPS1(补 fstab 零风险 + 需空闲才重启更新)。
    fix_vps1_fstab
    update_node vps1 vps
    ;;
  migrate) # 第三批:迁移 id(master 能读到各节点 nodeId 即可)。
    migrate_ids
    ;;
  all)     # 一次全做(旧行为;VPS1 不空闲就跳过)。
    fix_vps1_fstab
    update_node vps2 video-rec-2
    update_node vps1 vps
    migrate_ids
    ;;
  *) echo "未知 --stage: $STAGE(可选 first|vps1|migrate|all)" >&2; exit 2 ;;
esac

say "=== 自动部署结束(stage=$STAGE) ==="
if [[ ${#FAILED[@]} -gt 0 ]]; then
  say "未完成/失败: ${FAILED[*]}"
  exit 1
fi
