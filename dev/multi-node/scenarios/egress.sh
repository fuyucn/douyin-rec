# egress 验收档场景(issue #88):真房间真录制 → 真投稿(仅自己可见 + 关水印)→ 回读核对。**只在 egress 档**(e2e-verify 已断言)。
#
# 两步,且投稿被机械拦住直到显式确认:
#   run egress-record   真房间录一小段(controller 本机 worker,放行外网)→ 规则 mode=stage 合成待传。**不投稿**。
#   run egress-submit   需 DREC_EGRESS_CONFIRM_SUBMIT=<房间号> 才执行:规则切 upload → 立即再跑一场 → 真 biliup 投稿 → 回读。
# 必填 env:DREC_EGRESS_ROOM=<数字房间号>(只允许这一个房间;脚本拒绝其它规则共存)。
# 凭证:真 cookies 只读挂载给 controller;本脚本只在 controller 容器内用它回读,输出里不含 cookie / 完整稿件号。

egress_room() {
  local r=${DREC_EGRESS_ROOM:-}
  [[ $r =~ ^[0-9]{6,20}$ ]] || die "egress 场景必须设 DREC_EGRESS_ROOM=<数字房间号>"
  printf '%s' "$r"
}
mask_bv() { printf '%s' "${1:0:3}****${1: -3}"; }

# 只允许本房间的规则存在(其它规则可能会被同步/收口,egress 档不许误触)
egress_only_this_room() {
  local room=$1 others
  api GET /api/hub/rules
  others=$(printf '%s' "$API_BODY" | jq -r --arg r "$room" '[.[]|select(.roomSlug!=$r)|.key]|join(",")')
  [[ -z $others ]] || die "egress 档要求只存在目标房间的 hub 规则;发现其它规则: $others(先清掉再跑)"
}

# 分P 本地时长(秒,逐段):stage 里 mergeSegments=false 产出的各分段文件,ffprobe 实测
stage_parts() { # stage_parts <room> → 每行 "文件名 时长秒"
  cx sh -c "for f in \$(ls /output-data/stage/douyin_$1_*/*.ts /output-data/stage/douyin_$1_*/*.mp4 2>/dev/null | sort); do printf '%s %s\n' \"\$(basename \$f)\" \"\$(ffprobe -v error -show_entries format=duration -of csv=p=0 \$f)\"; done"
}

scenario_egress_record() {
  sc_begin EGRESS-RECORD "真房间录一小段(不投稿)"
  local room; room=$(egress_room)
  sc_require_fast_reconcile
  # 档位前提
  expect_true 网络 "controller 可出外网(egress)" cx curl -sS -m 10 -o /dev/null https://live.douyin.com
  if nx 1 curl -sS -m 5 -o /dev/null https://example.com >/dev/null 2>&1; then sc_fail "网络: node-1 居然能出外网"; else sc_pass "网络: node-1 仍断网(只录制)"; fi
  expect_true 二进制 "controller 的 biliup 是真的(不是假脚本)" cx sh -c '! grep -q fake-biliup /usr/local/bin/biliup && biliup -V'
  expect_eq 凭证 "controller 的 cookies 是只读挂载" "$(cx sh -c 'touch /output-data/config/biliup/cookies.json 2>&1 | grep -c "Read-only"' | tr -d ' ')" 1
  expect_eq 凭证 "worker 无真 cookies(含 FAKE-DEV)" "$(nx 1 sh -c 'grep -c FAKE-DEV /output-data/config/biliup/cookies.json' | tr -d ' ')" 1
  egress_only_this_room "$room"
  api DELETE "/api/hub/rules/douyin.$room" >/dev/null
  local t
  api POST /api/tasks "{\"room\":\"https://live.douyin.com/$room\",\"name\":\"e2e-egress\",\"segmentSec\":30,\"danmu\":0}"
  [[ $API_CODE == 201 ]] || die "建任务失败 HTTP $API_CODE: $API_BODY"
  t=$(printf '%s' "$API_BODY" | jq -r .id)
  mk_rule "$t" '["local"]' '{"upload":{"mode":"stage","private":true},"steps":{"mergeSegments":false,"burnDanmu":false,"burnLivechat":false},"cleanup":{"sourceAfterDone":false,"stageAfterDone":false}}' >/dev/null
  api POST "/api/tasks/$t/start"; expect_eq API "启动源任务 HTTP" "$API_CODE" 200
  rec() { api GET "/api/tasks/$t"; [[ $(printf '%s' "$API_BODY" | jq -r .recording) == true ]]; }
  if wait_for 240 rec; then sc_pass "API: 任务进入录制(recording=true)"; else
    sc_fail "API: 240s 内未开始录制(房间可能未开播 / 取流失败)"; ctrl_logs | tail -15 | sed 's/^/       » /'; return; fi
  sc_info "录制中,取 100s(30s 一段 ≈ 3 段)…"; sleep 100
  api POST "/api/tasks/$t/stop" >/dev/null; expect_eq API "停止源任务 HTTP" "$API_CODE" 200
  fin() { [[ $(job_state "$room") == needs_manual ]]; }
  wait_for 300 fin && sc_pass "台账: stage 模式合成完毕(needs_manual)" || { sc_fail "台账: 300s 内未到 needs_manual(state='$(job_state "$room")')"; return; }
  ledger "SELECT streamKey,state,winnerWorker FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%'" | jq -c '.[]' | sed 's/^/       » 台账 /'
  sc_info "stage 分 P(文件 时长秒):"; stage_parts "$room" | sed 's/^/       » /'
  local n; n=$(stage_parts "$room" | wc -l | tr -d ' ')
  expect_true 文件 "stage 至少 2 个分 P" test "$n" -ge 2
  sc_info "下一步(需用户确认后才可执行): DREC_EGRESS_ROOM=$room DREC_EGRESS_CONFIRM_SUBMIT=$room scripts/e2e-verify.sh run egress-submit --egress"
}

scenario_egress_submit() {
  sc_begin EGRESS-SUBMIT "真投稿(仅自己可见 + 关水印)+ 回读"
  local room; room=$(egress_room)
  [[ ${DREC_EGRESS_CONFIRM_SUBMIT:-} == "$room" ]] || die "拒绝投稿:需显式确认 DREC_EGRESS_CONFIRM_SUBMIT=$room(即将向 $room 投稿一条仅自己可见的私稿,事后需用户在创作中心手动删)"
  egress_only_this_room "$room"
  local base; base=$(ledger "SELECT streamKey FROM sync_jobs WHERE streamKey LIKE 'douyin:$room:%' AND state='needs_manual' ORDER BY updatedAt DESC LIMIT 1" | jq -r '.[0].streamKey // empty')
  [[ -n $base ]] || die "没有 needs_manual 的 stage 场次可投;先跑 egress-record"
  local key="${base}-1"
  stage_parts "$room" > /tmp/.egress-parts.$$
  api PATCH "/api/hub/rules/douyin.$room" '{"pipeline":{"upload":{"mode":"upload","private":true}}}'
  expect_eq API "规则切 upload(private=true)HTTP" "$API_CODE" 200
  api POST /api/hub/jobs/run "{\"streamKey\":\"$key\",\"winnerWorker\":\"local\"}"
  expect_eq API "立即执行 HTTP(202=已受理)" "$API_CODE" 202
  local jk="$key"
  fin() { [[ $(ledger "SELECT state FROM sync_jobs WHERE streamKey='$jk'" | jq -r '.[0].state // empty') == done ]]; }
  if wait_for 1800 fin; then sc_pass "台账: 真投稿 job done"; else
    sc_fail "台账: 1800s 内未 done"; ledger "SELECT node,state,error FROM sync_node_states WHERE streamKey='$jk'" | sed 's/^/       » /'; return; fi
  local bv; bv=$(ledger "SELECT bv FROM sync_jobs WHERE streamKey='$jk'" | jq -r '.[0].bv // empty')
  if [[ $bv =~ ^BV[0-9A-Za-z]{10}$ ]]; then sc_pass "台账: 取得 BV 号($(mask_bv "$bv"))"; else sc_fail "台账: BV 号非法"; return; fi
  printf '%s\n' "$bv" > "$E2E_ROOT/controller/.egress-bv"   # 仅留在 dev 数据根;down 时随数据清掉
  # 回读:pipeline 自带核验(clean_verify 步骤详情 = 'N 个分 P')+ 独立回读 pages/时长(容器内用真 cookies,输出不含凭证)
  local exp; exp=$(wc -l < /tmp/.egress-parts.$$ | tr -d ' ')
  expect_eq 台账 "clean_verify 回读分P数 = 本地分段数" "$(ledger "SELECT detail FROM sync_job_steps WHERE streamKey='$jk' AND step='clean_verify' ORDER BY at DESC LIMIT 1" | jq -r '.[0].detail // empty')" "$exp 个分 P"
  cx node -e '
    const fs=require("fs");const c=JSON.parse(fs.readFileSync("/output-data/config/biliup/cookies.json","utf8"));
    const ck=(c.cookie_info?.cookies||[]).map(x=>x.name+"="+x.value).join("; ");
    fetch("https://api.bilibili.com/x/web-interface/view?bvid="+process.argv[1],{headers:{"User-Agent":"Mozilla/5.0","Cookie":ck}})
      .then(r=>r.json()).then(j=>{const p=(j.data&&j.data.pages)||[];console.log(JSON.stringify({code:j.code,pages:p.length,durations:p.map(x=>x.duration)}));})
      .catch(e=>console.log(JSON.stringify({err:String(e.message||e)})));' "$bv" > /tmp/.egress-readback.$$
  sc_info "B站回读: $(cat /tmp/.egress-readback.$$)"
  expect_eq API "B站回读分P数 = 本地分段数" "$(jq -r .pages /tmp/.egress-readback.$$)" "$exp"
  local want got
  want=$(awk '{printf "%d,", $2+0.5}' /tmp/.egress-parts.$$ | sed 's/,$//')
  got=$(jq -r '.durations|map(.)|join(",")' /tmp/.egress-readback.$$)
  sc_info "本地各P时长(取整): $want / B站各P时长: $got"
  # 时长一致:逐 P 误差 ≤2s
  if awk -v a="$want" -v b="$got" 'BEGIN{n=split(a,x,",");m=split(b,y,",");if(n!=m)exit 1;for(i=1;i<=n;i++){d=x[i]-y[i];if(d<0)d=-d;if(d>2)exit 1}}'; then sc_pass "API: 逐P时长一致(误差≤2s)"; else sc_fail "API: 时长不一致"; fi
  # 关水印 / 仅自己可见:biliup 参数是代码硬标准常量(biliup.ts),这里核对 job.log 留痕 + 规则 private=true;API 无法回读水印位
  expect_eq 文件 "规则 private=true" "$(api GET /api/hub/rules; printf '%s' "$API_BODY" | jq -r --arg r "$room" '.[]|select(.roomSlug==$r)|.pipeline.upload.private')" true
  rm -f /tmp/.egress-parts.$$ /tmp/.egress-readback.$$
}
