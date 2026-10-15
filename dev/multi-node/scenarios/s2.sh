# S2 失联三态(#27)。docker stop(拒绝路径,快速失败)与 docker pause(挂起→超时路径)两法各跑一遍:
# 失联节点参与的场本轮不选优/不收口/不建 job、源文件不变;达阈值通知一次;恢复后补收口且连续计数复位(再失联可再报)。
PIPE_UP='{"upload":{"mode":"upload","private":true},"steps":{"burnDanmu":false,"burnLivechat":false},"cleanup":{"sourceAfterDone":false,"stageAfterDone":false}}'

# 节点源录像清单(名字+大小+mtime),用于断言「源文件不变」
manifest() { nx "$1" sh -c "cd /output-data/recordings/$2 && find . -type f -exec stat -c '%n %s %Y' {} + | sort"; }
alert_count() { api GET /api/events; printf '%s' "$API_BODY" | grep -o '节点 node-2 清单已连续' | wc -l | tr -d ' '; }
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
  local alerts0 arch0; alerts0=$(alert_count); arch0=$(arch_count "$anchor")
  fault "$down" 2
  local t; t=$(mk_task "$room" "$anchor")
  mk_rule "$t" '["node-1","node-2"]' "$PIPE_UP" >/dev/null
  api POST /api/hub/apply >/dev/null
  local logs0; logs0=$(lost_logs)
  have_lost() { [[ $(lost_logs) -gt $logs0 ]]; }
  wait_for 120 have_lost && sc_pass "$label/日志: controller 记录「清单失联,不当作无录像」" || sc_fail "$label/日志: 120s 内无失联日志"
  [[ $label == stop ]] || sc_info "[$label] pause 走超时路径:每轮 inventory 最长 60s,达阈值需约 6 轮,请耐心等"
  # 达阈值(默认 6 轮)后告警恰好 1 条。pause 路径每轮 ≥60s,故等待上限放宽。
  local lim=240; [[ $down == pause ]] || lim=150
  hit() { [[ $(( $(alert_count) - alerts0 )) -ge 1 ]]; }
  if [[ $down == pause ]]; then lim=720; fi
  wait_for $lim hit && sc_pass "$label/API: 失联达阈值发出通知(本阶段新增 $(( $(alert_count) - alerts0 )) 条)" || sc_fail "$label/API: ${lim}s 内未见阈值告警"
  if [[ $down == pause ]]; then sleep 70; else sleep 50; fi
  expect_eq "$label/API" "阈值后继续失联,通知不重复(本阶段新增条数)" "$(( $(alert_count) - alerts0 ))" 1
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
  wait_for 240 fin && sc_pass "$label/台账: 恢复后该场补收口 → done" || sc_fail "$label/台账: 恢复后未收口(state='$(job_state "$room")')"
  expect_eq "$label/台账" "候选含 node-1,node-2" "$(ledger "SELECT workerId FROM sync_candidates WHERE streamKey LIKE 'douyin:$room:%' ORDER BY workerId" | jq -r 'map(.workerId)|join(",")')" node-1,node-2
  expect_eq "$label/文件" "node-2 源录像清单与失联前一致(sourceAfterDone=false)" "$(manifest 2 "$anchor")" "$m2"
  expect_eq "$label/API" "workers/status 里 node-2 恢复 ok=true" "$(node2_status)" true
  expect_eq "$label/文件" "假 biliup 档案本阶段恰新增 1 次 upload(无重复建稿)" "$(( $(arch_count "$anchor") - arch0 ))" 1
  ledger "SELECT streamKey,state,winnerWorker,bv FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%'" | jq -c '.[]' | sed 's/^/       » 台账 /'
}

scenario_s2() {
  sc_begin S2 "失联三态:docker stop(拒绝)与 docker pause(超时)"
  sc_require_fast_reconcile
  local R1=900010011 A1=sc-s2-stop R2=900010012 A2=sc-s2-pause
  sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2
  s2_phase stop stop start $R1 $A1 1   # 末参为历史遗留占位,断言已改为本阶段增量
  # 恢复后连续计数复位:再次失联(pause)应能再发一条 → 累计 2
  s2_phase pause pause unpause $R2 $A2 2
  [[ ${SC_KEEP:-0} == 1 ]] || { sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2; }
}
