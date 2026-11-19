# S2 失联三态(#27)。docker stop(拒绝路径,快速失败)与 docker pause(挂起→超时路径)两法各跑一遍:
# 失联节点参与的场本轮不选优/不收口/不建 job、源文件不变;达阈值通知一次;恢复后补收口且连续计数复位(再失联可再报)。
PIPE_UP='{"upload":{"mode":"upload","private":true},"steps":{"burnDanmu":false,"burnLivechat":false},"cleanup":{"sourceAfterDone":false,"stageAfterDone":false}}'

# 节点源录像清单(名字+大小+mtime),用于断言「源文件不变」
manifest() { nx "$1" sh -c "cd /output-data/recordings/$2 && find . -type f -exec stat -c '%n %s %Y' {} + | sort"; }
alert_count() {
  api GET /api/events
  [[ $API_CODE == 200 ]] || return 1
  # Room escalation is a separate event prefixed by a stream key.
  printf '%s' "$API_BODY" | jq -er '[.events[] | select(.kind == "error" and (.message | startswith("节点 node-2 清单已连续 ")))] | length'
}

s2_blocked_round() {
  api GET /api/hub/queue
  [[ $API_CODE == 200 ]] || return 1
  printf '%s' "$API_BODY" | jq -er --arg room "$1" '
    [.blocked[] | select(.platform == "douyin" and .roomSlug == $room and .workers == ["node-2"])]
    | select(length == 1) | .[0]
    | select((.rounds | type) == "number" and (.threshold | type) == "number")
    | select(.rounds >= 1 and .rounds == (.rounds | floor) and .rounds < .threshold) | .rounds'
}
arch_count() { cx sh -c "cat /output-data/config/biliup/fake-archive.jsonl 2>/dev/null | grep '$1' | grep -c '\"op\":\"upload\"'; true" | tr -d ' '; }
lost_logs() { ctrl_logs | grep -c 'worker node-2 清单失联'; }
node2_status() { api GET /api/hub/workers/status; printf '%s' "$API_BODY" | jq -r '.[]|select(.id=="node-2")|.ok'; }

# s2_phase <label> <fault 动词:stop|pause> <恢复动词:start|unpause> <roomSlug> <anchor> <期望累计告警数>
s2_phase() {
  local label=$1 down=$2 up=$3 room=$4 anchor=$5 want_alerts=$6
  local END; END=$(( $(date +%s) - 3600 ))
  sc_info "[$label] 播种 node-1/node-2 同一场(各 2 段 10s),然后对 node-2 docker $down"
  seed 1 "$anchor" "$room" "$END" 2 10; seed 2 "$anchor" "$room" "$END" 2 10
  local m1 m2; m1=$(manifest 1 "$anchor"); m2=$(manifest 2 "$anchor")
  # events / fake-archive 跨多次运行累积:本阶段一律按「相对基线的增量」断言
  local alerts0 arch0 logs0
  if ! alerts0=$(alert_count); then sc_fail "$label/API: could not read node warning baseline"; return; fi
  arch0=$(arch_count "$anchor"); logs0=$(lost_logs)
  fault "$down" 2
  local t; t=$(mk_task "$room" "$anchor")
  mk_rule "$t" '["node-1","node-2"]' "$PIPE_UP" >/dev/null
  api POST /api/hub/apply >/dev/null
  have_lost() { [[ $(lost_logs) -gt $logs0 ]]; }
  if [[ $down == stop ]]; then
    # Preserve the existing warm-up budget, but assert the warning at the alert threshold.
    wait_for 120 have_lost || sc_info "[$label] inventory warning pending; checking again at the alert threshold"
  fi
  [[ $label == stop ]] || sc_info "[$label] pause 走超时路径:每轮 inventory 最长 60s,达阈值需约 6 轮,请耐心等"
  # 达阈值(默认 6 轮)后告警恰好 1 条。pause 路径每轮 ≥60s,故等待上限放宽。
  local lim=240; [[ $down == pause ]] || lim=150
  local alerts_seen
  hit() { alerts_seen=$(alert_count) && (( alerts_seen > alerts0 )); }
  if [[ $down == pause ]]; then lim=720; fi
  wait_for $lim hit && sc_pass "$label/API: 失联达阈值发出通知(本阶段新增 $(( alerts_seen - alerts0 )) 条)" || sc_fail "$label/API: ${lim}s 内未见阈值告警"
  # Either fault can hold an existing settle pass before inventory runs.
  # Check its warning within the unchanged threshold deadline, not a separate 120s guess.
  expect_true "$label/log" "unreachable inventory warning is present at the alert threshold" have_lost
  # Prove that the room stayed blocked after the warning without overshooting into manual escalation.
  local first_round next_round follow_up=50
  [[ $down != pause ]] || follow_up=70
  another_blocked_round() { next_round=$(s2_blocked_round "$room") && (( next_round > first_round )); }
  if first_round=$(s2_blocked_round "$room") && wait_for "$follow_up" another_blocked_round; then
    sc_pass "$label/API: observed another blocked round before manual escalation ($first_round → $next_round)"
  else
    sc_fail "$label/API: no further blocked round observed before manual escalation"
  fi
  if alerts_seen=$(alert_count); then
    expect_eq "$label/API" "阈值后继续失联,通知不重复(本阶段新增条数)" "$(( alerts_seen - alerts0 ))" 1
  else
    sc_fail "$label/API: could not read node warnings after the blocked round"
  fi
  # 失联期间:不选优 / 不收口 / 不建 job / 源不变
  expect_eq "$label/台账" "失联期间该场不建 job" "$(job_count "$room")" 0
  expect_eq "$label/台账" "失联期间无候选" "$(ledger "SELECT COUNT(*) n FROM sync_candidates WHERE streamKey LIKE 'douyin:$room:%'" | jq -r '.[0].n')" 0
  api GET "/api/hub/jobs?room=douyin.$room"; expect_eq "$label/API" "/api/hub/jobs 该房间无 job" "$(printf '%s' "$API_BODY" | jq -r .total)" 0
  expect_eq "$label/API" "workers/status 里 node-2 ok=false" "$(node2_status)" false
  expect_eq "$label/文件" "node-1 源录像清单失联前后不变" "$(manifest 1 "$anchor")" "$m1"
  expect_eq "$label/文件" "失联期间 fake-archive 无新增上传行" "$(( $(arch_count "$anchor") - arch0 ))" 0
  # 恢复
  sc_info "[$label] 恢复 node-2(docker $up),等下一轮对账"
  fault "$up" 2
  fin() { [[ $(job_state "$room") == done ]]; }
  _n2_up() { [[ $(node2_status) == true ]]; }
  wait_for 240 fin && sc_pass "$label/台账: 恢复后该场补收口 → done" || sc_fail "$label/台账: 恢复后未收口(state='$(job_state "$room")')"
  expect_eq "$label/台账" "候选含 node-1,node-2" "$(ledger "SELECT workerId FROM sync_candidates WHERE streamKey LIKE 'douyin:$room:%' ORDER BY workerId" | jq -r 'map(.workerId)|join(",")')" node-1,node-2
  expect_eq "$label/文件" "node-2 源录像清单与失联前一致(sourceAfterDone=false)" "$(manifest 2 "$anchor")" "$m2"
  # workers/status 是周期探测(缓存),恢复后需要再等一个探测周期才会翻回 true,不能立刻断言。
  wait_for 120 _n2_up && sc_pass "$label/API: workers/status 里 node-2 恢复 ok=true" || sc_fail "$label/API: workers/status 里 node-2 恢复 ok=true(120s 内未翻回,实际 '$(node2_status)')"
  expect_eq "$label/文件" "假 biliup 档案本阶段恰新增 1 次 upload(无重复建稿)" "$(( $(arch_count "$anchor") - arch0 ))" 1
  ledger "SELECT streamKey,state,winnerWorker,bv FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%'" | jq -c '.[]' | sed 's/^/       » 台账 /'
}

scenario_s2() {
  sc_begin S2 "失联三态:docker stop(拒绝)与 docker pause(超时)"
  sc_require_fast_reconcile
  local R1=900010011 A1=sc-s2-stop R2=900010012 A2=sc-s2-pause  # issue-guard: allow(dev 测试夹具:本机回环地址/假房间号)
  sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2
  s2_phase stop stop start $R1 $A1 1   # 末参为历史遗留占位,断言已改为本阶段增量
  # 恢复后连续计数复位:再次失联(pause)应能再发一条 → 累计 2
  s2_phase pause pause unpause $R2 $A2 2
  [[ ${SC_KEEP:-0} == 1 ]] || { sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2; }
}
