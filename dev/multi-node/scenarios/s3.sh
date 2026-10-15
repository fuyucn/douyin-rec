# S3 收口清理(#60/#61)。真 ffmpeg 分段 + session.json + xml,走收播对账 → 烧录 → 假 biliup 上传 → 清理。
# 重要(#92):收口清理以「上传确认(biliup rc=0)」为前提;回读 B站分P数只是旁路校验,不拦清理。
# 因此 internal 档(断外网、假 biliup)也能断言清零类结果。
# 口径(xmlKeepRule,orchestrator/src/pipeline.ts):stageAfterDone=true → stage 视频类清零、stage 的 .xml/.ass 可删、
# 节点源 .xml 必须保留;sourceAfterDone=true 时节点源视频(.ts)删。.xml 永不两处同时删光。

# s3_case <label> <roomSlug> <anchor> <sourceAfterDone true|false>
s3_case() {
  local label=$1 room=$2 anchor=$3 srcdone=$4
  local END; END=$(( $(date +%s) - 3600 ))
  sc_info "[$label] cleanup: sourceAfterDone=$srcdone stageAfterDone=true;burnDanmu=true(产出真 .ass)"
  # 档案在 dev 数据根里累积(重跑同一 anchor 不清),以本次开始前的行数为基线只数增量。
  local arch="/output-data/config/biliup/fake-archive.jsonl"
  local base_up base_ap
  base_up=$(cx sh -c "grep '$anchor' $arch 2>/dev/null | grep -c '\"op\":\"upload\"'" | tr -d ' '); base_ap=$(cx sh -c "grep '$anchor' $arch 2>/dev/null | grep -c '\"op\":\"append\"'" | tr -d ' ')
  seed 1 "$anchor" "$room" "$END" 2 10; seed 2 "$anchor" "$room" "$END" 2 10
  local t; t=$(mk_task "$room" "$anchor")
  mk_rule "$t" '["node-1","node-2"]' \
    "{\"upload\":{\"mode\":\"upload\",\"private\":true},\"steps\":{\"burnDanmu\":true,\"burnLivechat\":false},\"cleanup\":{\"sourceAfterDone\":$srcdone,\"stageAfterDone\":true}}" >/dev/null
  api POST /api/hub/apply >/dev/null
  fin() { [[ $(job_state "$room") == done ]]; }
  wait_for 360 fin && sc_pass "$label/台账: job done" || { sc_fail "$label/台账: 360s 内未 done(state='$(job_state "$room")')"; ledger "SELECT node,state,error FROM sync_node_states WHERE streamKey LIKE 'douyin:$room:%'" | sed 's/^/       » /'; return; }
  ledger "SELECT streamKey,state,winnerWorker,bv FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%'" | jq -c '.[]' | sed 's/^/       » 台账 /'
  expect_eq "$label/台账" "该场仅 1 个 job" "$(job_count "$room")" 1
  local bv; bv=$(ledger "SELECT bv FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%'" | jq -r '.[0].bv // empty')
  if [[ $bv =~ ^BV[0-9A-Za-z]{10}$ ]]; then sc_pass "$label/台账: bv 形如 BV 号(假 biliup)"; else sc_fail "$label/台账: bv 非 BV 号('$bv')"; fi
  expect_eq "$label/台账" "node_states 无 failed" "$(ledger "SELECT COUNT(*) n FROM sync_node_states WHERE streamKey LIKE 'douyin:$room:%' AND state='failed'" | jq -r '.[0].n')" 0
  sleep 40   # 再过 2 轮对账,验证不会重复建稿
  expect_eq "$label/台账" "再过 2 轮对账仍仅 1 个 job" "$(job_count "$room")" 1
  # 文件路
  local sd="/output-data/stage/douyin_${room}_*"
  # #92:清理只看上传确认(biliup rc=0),不再被「回读分P数」拦住;回读降为旁路校验(clean_verify)。
  expect_eq "$label/文件" "stage 视频类(.ts/.mp4/.flv)清零(上传已确认即清理)" "$(cx sh -c "ls $sd/*.ts $sd/*.mp4 $sd/*.flv 2>/dev/null | wc -l" | tr -d ' ')" 0
  expect_eq "$label/台账" "旁路校验 clean_verify 未失败(不阻塞清理)" "$(ledger "SELECT COUNT(*) n FROM sync_node_states WHERE streamKey LIKE 'douyin:$room:%' AND node='clean_verify' AND state='failed'" | jq -r '.[0].n')" 0
  expect_eq "$label/文件" "stage 的 .xml/.ass 已删(stageAfterDone=true,节点源保留 xml)" "$(cx sh -c "ls $sd/*.xml $sd/*.ass 2>/dev/null | wc -l" | tr -d ' ')" 0
  expect_true "$label/文件" "stage 仍有 job.log" cx sh -c "ls $sd/job.log"
  local n
  for n in 1 2; do
    expect_eq "$label/文件" "node-$n 源 .xml 保留(不得删最后一份)" "$(nx $n sh -c "ls /output-data/recordings/$anchor/*.xml | wc -l" | tr -d ' ')" 1
    expect_eq "$label/文件" "node-$n 会话 session.json 保留" "$(nx $n sh -c "ls /output-data/recordings/$anchor/*.session.json | wc -l" | tr -d ' ')" 1
  done
  if [[ $srcdone == true ]]; then
    expect_eq "$label/文件" "node-1 源视频 .ts 已按 sourceAfterDone 清理(上传已确认)" "$(nx 1 sh -c "ls /output-data/recordings/$anchor/*.ts 2>/dev/null | wc -l" | tr -d ' ')" 0
  else
    expect_eq "$label/文件" "node-1 源视频 .ts 保留(sourceAfterDone=false)" "$(nx 1 sh -c "ls /output-data/recordings/$anchor/*.ts | wc -l" | tr -d ' ')" 2
  fi
  # 假 biliup 档案:1 次 upload(P1=plain)+ 1 次 append(P2=danmu),全部关水印 + 仅自己可见
  expect_eq "$label/文件" "档案 upload 次数(无重复建稿)" "$(( $(cx sh -c "grep '$anchor' $arch | grep -c '\"op\":\"upload\"'" | tr -d ' ') - ${base_up:-0} ))" 1
  expect_eq "$label/文件" "档案 append 次数(danmu 分P)" "$(( $(cx sh -c "grep '$anchor' $arch | grep -c '\"op\":\"append\"'" | tr -d ' ') - ${base_ap:-0} ))" 1
  expect_eq "$label/文件" "档案每行 watermarkOff 且 onlySelf" "$(cx sh -c "grep '$anchor' $arch | grep -vc '\"watermarkOff\":true,\"onlySelf\":true'" | tr -d ' ')" 0
  # API 路
  api GET "/api/hub/jobs?room=douyin.$room"
  expect_eq "$label/API" "/api/hub/jobs 该场 state" "$(printf '%s' "$API_BODY" | jq -r '.jobs[0].state')" done
  api GET /api/hub/queue
  expect_eq "$label/API" "/api/hub/queue 无在途该场" "$(printf '%s' "$API_BODY" | jq --arg r ":$room:" '[.active[]|select(.streamKey|contains($r))]|length')" 0
}

scenario_s3() {
  sc_begin S3 "收口清理:stageAfterDone=true;sourceAfterDone=false / true 两种"
  sc_require_fast_reconcile
  local R1=900010021 A1=sc-s3-keep R2=900010022 A2=sc-s3-del
  sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2
  s3_case keep $R1 $A1 false
  s3_case del  $R2 $A2 true
  [[ ${SC_KEEP:-0} == 1 ]] || { sc_cleanup_room $R1 $A1; sc_cleanup_room $R2 $A2; }
}
