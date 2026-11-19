# S1 ownership removal (#73/#442): task sync, ledger candidates, and source-file retention.
scenario_s1() {
  sc_begin S1 "撤销节点分配后两阶段删除任务行,保留源录像;停用规则保留已选节点任务"
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
  napi 2 GET /api/tasks
  expect_eq API "读取 node-2 任务列表 HTTP" "$API_CODE" 200
  local a2_id; a2_id=$(printf '%s' "$API_BODY" | jq -r --arg r "/$RA" '[.[]|select(.room|endswith($r))][0].id // empty')
  expect_true API "captured node-2 A task id before unassignment" test -n "$a2_id"

  # 撤掉 node-2:规则 A 只勾 node-1
  api PATCH "/api/hub/rules/douyin.$RA" '{"workers":["node-1"]}'
  expect_eq API "PATCH 规则 A workers=[node-1] HTTP" "$API_CODE" 200
  api POST /api/hub/apply >/dev/null
  expect_eq API "POST /api/hub/apply accepted HTTP" "$API_CODE" 202
  a_removed() {
    napi 2 GET /api/tasks
    [[ $API_CODE == 200 ]] || return 1
    [[ $(printf '%s' "$API_BODY" | jq --arg id "$a2_id" '[.[]|select((.id|tostring)==$id)]|length') == 0 ]]
  }
  wait_for 90 a_removed || sc_fail "node-2 上 A 的原任务 id 未在两阶段同步后删除"

  napi 1 GET /api/tasks
  expect_eq API "读取 node-1 任务列表 HTTP" "$API_CODE" 200
  local a1; a1=$(printf '%s' "$API_BODY" | jq -c --arg r "/$RA" '[.[]|select(.room|endswith($r))][0] // empty')
  napi 2 GET /api/tasks
  expect_eq API "读取 node-2 任务列表 HTTP" "$API_CODE" 200
  local node2_tasks=$API_BODY b2
  b2=$(printf '%s' "$node2_tasks" | jq -c --arg r "/$RB" '[.[]|select(.room|endswith($r))][0] // empty')
  local b2_id; b2_id=$(printf '%s' "$b2" | jq -r '.id // empty')
  sc_info "node-1 A: $(printf '%s' "$a1" | jq -c '{managedBy,assigned,enabled,recording,running}')"
  sc_info "node-2 B: $(printf '%s' "$b2" | jq -c '{managedBy,assigned,enabled,recording,running}')"
  expect_true API "captured node-2 B task id before rule disable" test -n "$b2_id"
  # --- API 路
  expect_eq API "node-1 上 A assigned=true" "$(printf '%s' "$a1" | jq -r .assigned)" true
  expect_eq API "node-2 上 A 的原任务 id 已移除" "$(printf '%s' "$node2_tasks" | jq --arg id "$a2_id" '[.[]|select((.id|tostring)==$id)]|length')" 0
  expect_eq API "node-2 上仍分配的 B 仍 assigned=true" "$(printf '%s' "$b2" | jq -r .assigned)" true
  local hidden shown
  hidden=$(printf '%s' "$node2_tasks" | jq "[.[]|select($HIDDEN_JQ)]|length")
  shown=$(printf '%s' "$node2_tasks" | jq "[.[]|select($HIDDEN_JQ|not)]|length")
  expect_eq API "node-2 没有残留的未分配任务" "$hidden" 0
  expect_eq API "node-2 显示仍分配的 B" "$shown" 1
  napi 1 GET /api/tasks
  expect_eq API "读取 node-1 任务列表 HTTP" "$API_CODE" 200
  expect_eq API "node-1 隐藏数" "$(printf '%s' "$API_BODY" | jq "[.[]|select($HIDDEN_JQ)]|length")" 0
  # The snapshot must retain the explicit deletion marker while the source files remain.
  expect_eq 文件 "node-2 managed/rooms.json 中 A 标记为删除" \
    "$(nx 2 cat /output-data/config/managed/rooms.json | jq -r --arg r $RA '.desired[]|select(.roomSlug==$r)|.deleted')" true
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
  # Keep B assigned while disabling its rule; the existing managed task must remain and reject local writes.
  api PATCH "/api/hub/rules/douyin.$RB" '{"enabled":false}'
  expect_eq API "PATCH 规则 B enabled=false HTTP" "$API_CODE" 200
  api POST /api/hub/apply >/dev/null
  expect_eq API "POST /api/hub/apply after disabling B accepted HTTP" "$API_CODE" 202
  b_disabled() {
    napi 2 GET /api/tasks
    [[ $API_CODE == 200 ]] || return 1
    [[ $(printf '%s' "$API_BODY" | jq --arg id "$b2_id" 'any(.[];((.id|tostring)==$id) and (.enabled==false))') == true ]]
  }
  wait_for 90 b_disabled || sc_fail "node-2 上仍被 worker 选择的 B 未保持为禁用任务"
  napi 2 GET /api/tasks
  expect_eq API "读取 node-2 任务列表 HTTP" "$API_CODE" 200
  local b2_retained; b2_retained=$(printf '%s' "$API_BODY" | jq -c --arg id "$b2_id" '[.[]|select((.id|tostring)==$id)][0] // empty')
  expect_eq API "规则停用后 B 任务仍存在" "$(printf '%s' "$API_BODY" | jq --arg id "$b2_id" '[.[]|select((.id|tostring)==$id)]|length')" 1
  expect_eq API "规则停用后 B enabled=false" "$(printf '%s' "$b2_retained" | jq -r .enabled)" false
  napi 2 POST "/api/tasks/$b2_id/start";  expect_eq API "node-2 start 仍存在的受管 B" "$API_CODE" 403
  napi 2 PATCH "/api/tasks/$b2_id" '{"name":"x"}'; expect_eq API "node-2 PATCH 仍存在的受管 B" "$API_CODE" 403
  napi 2 DELETE "/api/tasks/$b2_id";      expect_eq API "node-2 DELETE 仍存在的受管 B" "$API_CODE" 403
  [[ ${SC_KEEP:-0} == 1 ]] || { sc_cleanup_room $RA $AA; sc_cleanup_room $RB $AB; }
}
