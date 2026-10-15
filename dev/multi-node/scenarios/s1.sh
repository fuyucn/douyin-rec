# S1 归属隐藏(#73)。三路:节点快照/API(assigned、隐藏判定、403)+ 台账(选优候选只含被选中节点)+ 文件(节点源保留)。
scenario_s1() {
  sc_begin S1 "归属隐藏:规则 A 先勾 node-1+2 再撤掉 node-2,规则 B 始终勾 node-1+2"
  sc_require_fast_reconcile
  local RA=900010001 RB=900010002 AA=sc-s1-a AB=sc-s1-b  # issue-guard: allow(dev 测试夹具:本机回环地址/假房间号)
  sc_cleanup_room $RA $AA; sc_cleanup_room $RB $AB
  local END; END=$(( $(date +%s) - 3600 ))
  local ta tb
  ta=$(mk_task $RA s1-a); tb=$(mk_task $RB s1-b)
  sc_info "源任务 A=$ta B=$tb(启用 + off-hours 调度窗口,daemon 不取流)"
  mk_rule "$ta" '["node-1","node-2"]' '{"upload":{"mode":"stage"},"steps":{"burnDanmu":false,"burnLivechat":false}}' >/dev/null
  mk_rule "$tb" '["node-1","node-2"]' '{"upload":{"mode":"stage"},"steps":{"burnDanmu":false,"burnLivechat":false}}' >/dev/null
  api POST /api/hub/apply >/dev/null
  both() { [[ -n $(node_task 1 $RA) && -n $(node_task 2 $RA) && -n $(node_task 2 $RB) && -n $(node_task 1 $RB) ]]; }
  wait_for 90 both || sc_fail "双节点未物化 A/B 受管任务"
  sc_info "阶段 1:A、B 都派给 node-1+2 → 两节点都 assigned=true"
  expect_eq API "node-2 上 A assigned" "$(node_task 2 $RA | jq -r .assigned)" true

  # 撤掉 node-2:规则 A 只勾 node-1
  api PATCH "/api/hub/rules/douyin.$RA" '{"workers":["node-1"]}'
  expect_eq API "PATCH 规则 A workers=[node-1] HTTP" "$API_CODE" 200
  api POST /api/hub/apply >/dev/null
  un() { [[ $(node_task 2 $RA | jq -r .assigned) == false ]]; }
  wait_for 90 un || sc_fail "node-2 上 A 未变 assigned=false"

  local a1 a2 b2
  a1=$(node_task 1 $RA); a2=$(node_task 2 $RA); b2=$(node_task 2 $RB)
  sc_info "node-1 A: $(printf '%s' "$a1" | jq -c '{managedBy,assigned,enabled,recording,running}')"
  sc_info "node-2 A: $(printf '%s' "$a2" | jq -c '{managedBy,assigned,enabled,recording,running}')"
  sc_info "node-2 B: $(printf '%s' "$b2" | jq -c '{managedBy,assigned,enabled,recording,running}')"
  # --- API 路
  expect_eq API "node-1 上 A assigned=true" "$(printf '%s' "$a1" | jq -r .assigned)" true
  expect_eq API "node-2 上 A assigned=false(停用保留,非删除)" "$(printf '%s' "$a2" | jq -r .assigned)" false
  expect_eq API "node-2 上 A enabled=false" "$(printf '%s' "$a2" | jq -r .enabled)" false
  expect_eq API "node-2 上 B 仍 assigned=true" "$(printf '%s' "$b2" | jq -r .assigned)" true
  napi 2 GET /api/tasks
  local hidden shown
  hidden=$(printf '%s' "$API_BODY" | jq "[.[]|select($HIDDEN_JQ)]|length")
  shown=$(printf '%s' "$API_BODY" | jq "[.[]|select($HIDDEN_JQ|not)]|length")
  expect_eq API "node-2 默认隐藏(未分配 ∧ 未在录)任务数" "$hidden" 1
  expect_eq API "node-2 默认显示任务数(仅 B)" "$shown" 1
  napi 1 GET /api/tasks
  expect_eq API "node-1 隐藏数" "$(printf '%s' "$API_BODY" | jq "[.[]|select($HIDDEN_JQ)]|length")" 0
  # 受管任务写操作 403(在 node-2 上对 A 与 B 都验)
  local id2; id2=$(printf '%s' "$a2" | jq -r .id)
  napi 2 POST "/api/tasks/$id2/start";  expect_eq API "node-2 start 受管任务" "$API_CODE" 403
  napi 2 PATCH "/api/tasks/$id2" '{"name":"x"}'; expect_eq API "node-2 PATCH 受管任务" "$API_CODE" 403
  napi 2 DELETE "/api/tasks/$id2";      expect_eq API "node-2 DELETE 受管任务" "$API_CODE" 403
  # --- 文件路(节点快照 + 任务仍在 DB)
  expect_eq 文件 "node-2 managed/rooms.json 中 A assigned" \
    "$(nx 2 cat /output-data/config/managed/rooms.json | jq -r --arg r $RA '.desired[]|select(.roomSlug==$r)|.assigned')" false
  expect_eq 文件 "node-1 managed/rooms.json 中 A assigned" \
    "$(nx 1 cat /output-data/config/managed/rooms.json | jq -r --arg r $RA '.desired[]|select(.roomSlug==$r)|.assigned')" true

  # --- 台账路:录像放两节点,收口后候选只含被选中的节点
  seed 1 $AA $RA "$END"; seed 2 $AA $RA "$END"
  seed 1 $AB $RB "$END"; seed 2 $AB $RB "$END"
  api POST /api/hub/apply >/dev/null
  # stage 模式的设计终态 = needs_manual(「合成完毕待人工上传」,pipeline.ts);不是故障
  fin() { [[ $(job_state $RA) == needs_manual && $(job_state $RB) == needs_manual ]]; }
  wait_for 240 fin || sc_fail "A/B 未在 240s 内收口: A=$(job_state $RA) B=$(job_state $RB)"
  expect_eq 台账 "A 候选节点(只勾 node-1)" \
    "$(ledger "SELECT workerId FROM sync_candidates WHERE streamKey LIKE 'douyin:$RA:%' ORDER BY workerId" | jq -r 'map(.workerId)|join(",")')" node-1
  expect_eq 台账 "B 候选节点(勾 node-1+2)" \
    "$(ledger "SELECT workerId FROM sync_candidates WHERE streamKey LIKE 'douyin:$RB:%' ORDER BY workerId" | jq -r 'map(.workerId)|join(",")')" node-1,node-2
  expect_eq 台账 "A job state(stage 模式合成完毕待人工)" "$(job_state $RA)" needs_manual
  expect_eq 文件 "A 的 stage 合成成品 .mp4 在位" "$(cx sh -c "ls /output-data/stage/douyin_${RA}_*/*.mp4 | wc -l" | tr -d ' ')" 1
  # 文件:未分配的 node-2 上 A 的录像没被动
  expect_eq 文件 "node-2 上 A 的 .ts 仍在(未派给≠删除)" "$(nx 2 sh -c "ls /output-data/recordings/$AA/*.ts | wc -l" | tr -d ' ')" 2
  ledger "SELECT streamKey,state,winnerWorker,error FROM sync_jobs WHERE streamKey LIKE 'douyin:$RA:%' OR streamKey LIKE 'douyin:$RB:%'" | jq -c '.[]' | sed 's/^/       » 台账 /'
  [[ ${SC_KEEP:-0} == 1 ]] || { sc_cleanup_room $RA $AA; sc_cleanup_room $RB $AB; }
}
