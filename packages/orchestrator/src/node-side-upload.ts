/**
 * node-side-upload.ts — 节点侧上传(**experimental**,见 plans/027)的 master 侧全部逻辑。
 *
 * ⚠️ 本文件是实验功能的**唯一入口**。要快速开关/回退,只动这一个文件:
 *   - **全局停用**:把 `NODE_SIDE_UPLOAD_ENABLED` 改成 `false` → 即使规则里开了
 *     `pipeline.steps.nodeSideUpload` 也一律回落现状(不改任何规则文件)。
 *   - **彻底移除**:删本文件 + `@drec/app` 的 `node-pipeline.ts` + cli 的
 *     `node-pipeline-commands.ts`,再删 pipeline.ts 里的调用点(见 `maybeRunNodeSideUpload`)。
 *
 * 背景(为什么做):实测 pull(rsync 回传录像)是后处理主要耗时(165s~4198s),而 9/16 房间
 * 不烧录、其 merge 只是 `-c copy` 纯 I/O —— 这类房间可让 winner 节点本地 remux + 上传,
 * 省掉整场录像回传。
 *
 * 边界(硬性):
 *   - **仅 upload 模式**:stage 模式的产物必须落 master 的 stage 目录(用户要拿这些文件),
 *     省回传会让该模式失去意义;且 stage 不上传,节点侧执行无任何收益。
 *   - **仅不烧录**:burn 是全量重编码,需 11 核 + 中文字体;弱节点(2 vCPU,~77% steal)
 *     实测仅 0.38x 实时,烧不动。
 *   - 节点缺能力(biliup / B站 cookie / 旧 bundle)→ 回落现状,**记明原因,绝不静默**。
 */
import { resolveDiskMinGB, type NodePipelineSpec } from "@drec/core";
import type { JobState, SyncLedger } from "./ledger.js";
import { cleanupSourcesShared, defaultRmStage, type PipelineCfg, type PipelineDeps } from "./pipeline.js";
import type { Transport } from "./transport.js";
import type { NotifyEvent } from "@drec/core";

/**
 * **实验功能总开关(kill switch)**。`false` = 全局停用节点侧上传,任何规则设置都不生效。
 * 出问题时把它改 false 即可一键回退,不必动规则文件或数据库。
 */
export const NODE_SIDE_UPLOAD_ENABLED = true;

/** 是否满足「走节点侧上传」的全部前置条件(纯函数,便于单测;不查节点能力——那要 IO,在 executor 里做)。 */
export function shouldUseNodeSideUpload(
  cfg: Pick<PipelineCfg, "uploadMode" | "steps">,
  burn: { burnDanmu: boolean; burnLivechat: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!NODE_SIDE_UPLOAD_ENABLED) return { ok: false, reason: "实验功能已被全局开关停用(NODE_SIDE_UPLOAD_ENABLED=false)" };
  if (!cfg.steps?.nodeSideUpload) return { ok: false, reason: "规则未开启 nodeSideUpload" };
  if (cfg.uploadMode !== "upload") return { ok: false, reason: "本场为 stage 模式(产物需落 master)" };
  if (burn.burnDanmu || burn.burnLivechat) {
    return { ok: false, reason: `本场需烧录(danmu=${burn.burnDanmu} livechat=${burn.burnLivechat})` };
  }
  return { ok: true };
}

/**
 * **磁盘水位闸门**(issue #8,纯函数:executor 与将来的消费点共用同一份实现,避免口径漂移)。
 *
 * 为什么需要:节点侧上传在选路时只看 biliup / cookie,不看剩余磁盘 ⇒ 节点盘写满时仍走节点侧
 * → 节点本地 remux 写盘 `ENOSPC` → 节点进程非 0 退出 → ssh rc≠0 → 保守转人工(线上实测一整簇)。
 *
 * 阈值口径与 reconciler 的**磁盘看门狗同源**:同一个配置键(hub.config `resources.diskMinGB`,
 * 经 `PipelineCfg.diskMinGB` 传下来),同一个默认值 10、同一条「`<=0` = 关闭」语义 ——
 * 这里不新增第二套阈值。
 *
 * 边界(想清楚了才写的):
 *   - 阈值 `undefined` / `<=0` → **闸门关闭**(不拦):与 reconciler
 *     `diskMinGB <= 0 → return`(关闭看门狗)一致,也是向后兼容路径(旧调用方不传阈值)。
 *     非数字(字符串/NaN)→ 不静默绕过,经 core `resolveDiskMinGB` 回落默认 10GB(issue #38)。
 *   - `freeGB` **完全没有**(`null`/`undefined`/非有限数,旧或自定义 transport 不给该字段)
 *     → **不因磁盘拦**:拿不到读数不等于盘满,拦下等于把「探测异常」当「盘满」白放弃省回传;
 *     与 serve.ts 里 `freeBytes()` 取不到返回 `null`(不拦)同一口径,靠 reconciler 看门狗告警兜底。
 *   - `freeGB` **读数为 0/接近 0** → **拦下**。注意 SSH 路径上「探测失败」会被
 *     transport-ssh 归一成 `0`(既有口径),与「盘真满」不可区分;两者都该回落 pull 回 master
 *     (那是节点侧上传出现前的原有路径,不丢任何东西)。线上实测的 `磁盘=0.0GB` 正是此列。
 *   - 两者都有效且 `freeGB < 阈值` → 拦住,返回原因字符串(**调用方必须记进日志,绝不静默**)。
 */
export function diskWatermarkGate(
  freeGB: number | null | undefined,
  minGB: number | null | undefined,
): { ok: true } | { ok: false; reason: string } {
  // 未注入(旧调用方/测试)= 关闭;注入了但非数字(字符串/NaN)→ 不得静默绕过,按 core 统一口径回落 10GB。
  if (minGB == null) return { ok: true };
  const { gb: min } = resolveDiskMinGB(minGB);
  if (min <= 0) return { ok: true };
  if (freeGB == null || !Number.isFinite(freeGB)) return { ok: true };
  if (freeGB < min) {
    return {
      ok: false,
      reason: `剩余磁盘 ${freeGB.toFixed(1)}GB < 阈值 ${min}GB(盘满会让本地 remux 写盘 ENOSPC)`,
    };
  }
  return { ok: true };
}

/** 能力探测里的磁盘读数展示:探测失败(null/缺失)→ `未知`(不谎报 0GB;也不拼出「未知GB」)。 */
function fmtFreeGB(freeGB: number | null | undefined): string {
  return freeGB == null || !Number.isFinite(freeGB) ? "未知" : `${freeGB.toFixed(1)}GB`;
}

export interface NodeSideUploadArgs {
  streamKey: string;
  cfg: PipelineCfg;
  winner: { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } };
  winnerMembers: readonly { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } }[];
  /**
   * 本场**全部**在场成员(含落败节点)。收尾删源要按它来 —— 与 master 常规路径的
   * `candidates.members` 同口径:落败节点的源同样是冗余副本,不删就永远占着磁盘。
   * 缺省回落 `winnerMembers`(旧调用方/单测兼容)。
   */
  members?: readonly { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } }[];
  transport: Transport;
  ledger: SyncLedger;
  jlog: (m: string) => void;
  notify: (e: NotifyEvent) => void;
  deps: PipelineDeps;
  /**
   * 本场最早会话(开播时刻 + 直播标题 + 会话 base 的来源)。
   * 与 master 常规路径的 `earliest` 同一取值口径,保证节点侧渲染与 master **逐字一致**
   * (否则 `{title}` 空 → 稿件标题不一致、`{HH}-{mm}-{ss}` 渲染成上传时刻)。
   */
  earliest?: { rec: { sessionBase?: string; startMs?: number; title?: string } };
  /** 本场开播时刻兜底(broadcast.startMs);earliest 缺失时用。 */
  broadcastStartMs?: number;
}

/**
 * 节点侧上传**已确认成功**后的共同收尾:标记 done + 删各成员节点的原始录像。
 *
 * 成功路径与「假失败回读确认成功」两条分支**共用这一份** —— 收尾只有一处实现,
 * 不会出现「一条分支删源、另一条忘了删」的漂移(那正是本次泄漏的成因)。
 *
 * 只做「节点源」这一段:节点侧**没有 pull** ⇒ stage 里不存在拉来的源副本,故
 * `stagePulledSources` 不传(② 那段自然不触发);节点 stage 里的成品由节点自己的
 * `cleanStageAfterDone` 清(见 app/node-pipeline.ts)。
 * `.xml` 一律保留(`keepNodeXml`):节点侧**从不把 xml 拉回/复制进 stage**(没有 pull)⇒
 * 节点源 xml 恒为**最后一份**。常规路径的 `xmlKeepRule("node", stageAfterDone)` 不适用 ——
 * 它的前提是「stage 里有 xml 副本」,而这里没有,照搬会在 stageAfterDone=false 时删掉唯一副本。
 *
 * 时序与 master 一致:先 `markDone`(上传确已成功)再删源;删失败只把 `clean_source`
 * 标 failed 供 reconciler 补跑,**不改终态**(否则会诱导重传 → 重复稿)。
 */
async function finalizeNodeSuccess(
  o: NodeSideUploadArgs,
  bv: string,
  note?: string,
): Promise<{ state: JobState; bv?: string }> {
  const { streamKey, cfg, winnerMembers, ledger, jlog } = o;
  ledger.markDone(streamKey, bv);
  if (note) ledger.logStep(streamKey, "node_upload", "done", note);
  // 节点表也记一笔:队列页「当前节点」优先取 nodeStates 里 running/done 的节点,
  // 只有 steps 记 node_upload 而节点表没有 → 仍会回落到 stateToNode("syncing")="pull"(旧误报)。
  ledger.syncNodeState(streamKey, "node_upload", "done");
  const cleanOutcome = await cleanupSourcesShared({
    streamKey, ledger, transports: o.deps.transports,
    members: o.members ?? winnerMembers,
    cleanup: cfg.cleanup, keepNodeXml: true,
    rmStage: o.deps.rmStage ?? defaultRmStage, log: jlog,
  });
  if (!cleanOutcome.ok) {
    jlog(`节点侧收尾清理部分失败(${cleanOutcome.failed.length}):`
      + `${cleanOutcome.failed.map((f) => f.target).join(",")}(已记 clean_source failed,待 reconciler 补跑)`);
  }
  // 注意:节点侧路径从不写 sync_parts 基线,回读分 P 数无从比对,故这里**不排**旁路校验(issue #92)。
  return { state: "done", bv };
}

/**
 * 节点侧上传**失败路径的统一收口**(catch / `!result.ok` 共用,避免两处各写一份判定)。
 *
 * 核心:失败**不代表没成功**。`_node-pipeline` 是长命令,ssh 可能在节点跑完上传之前断开
 * (实测 rc=255,而节点上的稿件其实已建好:private + 多分 P)。所以先**回读节点落盘结果**:
 *
 * 收口顺序:**先终止节点执行体(A2),再回读落盘结果**。先杀后读,执行体不会在「读之后」又写
 * 新阶段/偷偷建稿 —— 这正是 issue #2 静默分裂的根因(台账说 failed,节点稍后才建出第二份稿)。
 *
 *   - `phase:"done"` + `ok` + bv → 其实成功了 → `markDone` + 删源(与成功路径同一份收尾),
 *     返回 `{state:"done"}` —— 这就是「假失败」的修复;
 *   - `phase:"done"` + `ok` 但 **无 bv**(如多分 P 上传中/漏记)→ 已建稿但证明不全 → 转人工,不重传;
 *   - `phase:"uploading"` → 已进入 biliup 上传循环 ⇒ **结果不确定** ⇒ 转人工(绝不自动重传);
 *   - `phase:"started"`(A1「尽早落盘」)→ 节点已接管、进入 remux,但**尚未调用 biliup**(无建稿风险):
 *       · master **已确认终止执行体**(`abort.aborted === true`)→ 执行体不可能再建稿 → **确认没成**走
 *         failed 路径(不堆人工,人工重触发安全);
 *       · **无法确认终止**(旧 bundle 无 `_node-abort` / 不可达 → `aborted === false`)→ 执行体可能仍在跑、
 *         稍后会写 uploading 并建稿 → **结果不确定**转人工,禁自动重试(避免「台账 failed、节点偷偷建稿」);
 *   - `phase:"failed"`(无 bv) / `null` → 确认没成 → 按原失败路径(failed + 不安全重试标记)。
 *
 * 关键安全不变量:**任何「可能已建稿」的分支都不得让 reconciler 自动重试** —— 重复投稿不可逆
 * (B站不支持改稿件视频内容)。故 `uploading` / 成功但无 bv / failed 且带 bv / started 且未确认终止
 * 一律 `needs_manual`。反过来 `started` 且**已确认终止** = 真的没建稿 → `failed`(既不自动重试也允许人工安全重投)。
 */
async function handleNodeFailure(o: NodeSideUploadArgs, errMsg: string, elapsedSec?: number): Promise<{ state: JobState; bv?: string }> {
  const { streamKey, transport, ledger, jlog, notify } = o;
  const suffix = elapsedSec === undefined ? "" : `(${elapsedSec}s)`;
  jlog(`节点侧执行失败: ${errMsg}${suffix} → 回读节点落盘结果判定是否其实已成功`);
  ledger.logStep(streamKey, "node_upload", "done", `节点侧失败: ${errMsg.slice(0, 120)}`);
  // 注意:此处**不**立刻把节点表标 failed —— node_upload 的 running 标记留着,直到下面某条
  // 终态分支(回读成功→done / 不确定→failed / 确认没成→failed)。否则回读这段窗口内
  // nodeStates 无 running 节点,队列页会回落到 stateToNode("syncing")="pull"(又误报)。

  // A2:**先主动终止节点执行体,再回读**。否则执行体可能在我们读完之后、收口之前又写新阶段/建稿
  // (ssh 超时只杀本地 ssh 客户端,远端 node + biliup/ffmpeg 不受控)→ 「台账 failed、节点仍在建稿」的
  // 静默分裂(重复投稿,不可逆)。`abortNodePipeline` 自身**绝不抛**(旧 bundle 降级为 aborted:false);
  // 这里再包一层 .catch 兜底,确保**任何情况下都不掩盖原始失败原因**(errMsg 仍是本次失败的权威记录)。
  let executorStopped = false; // 是否「确认执行体已停」—— 决定 started 走 failed 还是 needs_manual
  if (transport.abortNodePipeline) {
    try {
      const abort = await transport.abortNodePipeline(streamKey);
      executorStopped = abort?.aborted === true;
      jlog(`已请求终止节点执行体(${streamKey}):${executorStopped ? "确认已停" : `无法确认(${abort?.detail ?? "未知"})`}`);
    } catch (e) {
      jlog(`终止节点执行体异常(忽略,按未确认处理):${String((e as Error)?.message ?? e)}`);
      executorStopped = false;
    }
  } else {
    jlog(`transport 不支持 _node-abort(旧 bundle)→ 无法终止执行体,结果按保守口径处理`);
  }

  let node = null;
  try {
    node = await transport.nodeResult?.(streamKey) ?? null;
  } catch {
    node = null; // 回读本身失败 → 按「确认没成」处理(与原行为一致,安全:只是保守不自动重试)
  }

  if (node?.phase === "done" && node.ok && node.bv) {
    jlog(`节点侧**其实已成功**(ssh 回传失败/超时,但节点落盘结果 ok=true BV=${node.bv})→ 收口 done,不重传`);
    return await finalizeNodeSuccess(o, node.bv, `节点侧已完成(回传失败,落盘回读 BV=${node.bv})`);
  }

  // 「可能已建稿」的分支 → needs_manual,绝不自动重试(自动重试 = 重复投稿)。
  // `started` 且**未能确认终止执行体**也归此类(执行体可能稍后偷偷建稿);`started` 且已确认终止
  // 落到下面「确认没成」分支(执行体被杀掉时还没调 biliup → 真的没建稿)。
  const maybePublished = node?.phase === "uploading"
    || (node?.phase === "done" && !node.bv)
    || (node?.phase === "failed" && !!node.bv)
    || (node?.phase === "started" && !executorStopped);
  if (maybePublished) {
    const why = node?.phase === "uploading"
      ? `节点已开始上传但结果未知(可能已建稿${node.bv ? ` BV=${node.bv}` : ""})`
      : node?.phase === "started"
        ? `节点已接管(remux 阶段)但未能确认终止执行体(旧 bundle 不支持终止 / 不可达):执行体可能仍在跑并稍后建稿`
        : node?.bv ? `节点已建稿 BV=${node.bv} 但未确认完成` : `节点上报完成但缺 BV,无法确认分 P`;
    const progress = node?.confirmedParts != null
      ? `(已确认 ${node.confirmedParts} 个分 P${node.intentPart ? `,第 ${node.intentPart} 个追加结果未知` : ""})`
      : "";
    const note = `${why}${progress};已禁止自动重试,请人工核对 B站稿件后处理`;
    jlog(`节点侧结果不确定: ${note}`);
    // issue #25 ②:回读到 BV 就记进台账(此前超时被杀后台账无任何 BV,人工只能去 B站翻稿件)。
    if (node?.bv) ledger.setBv(streamKey, node.bv);
    ledger.logStep(streamKey, "node_upload", "done", `节点侧结果不确定: ${why.slice(0, 120)}`);
    ledger.syncNodeState(streamKey, "node_upload", "failed", { error: note.slice(0, 200) });
    // sync_node_states 行必须写:reconciler 的自动重试闸门看的是它(= 不安全重试标记)。
    ledger.syncNodeState(streamKey, "upload_plain", "failed", { error: note.slice(0, 200) });
    ledger.setState(streamKey, "needs_manual", { error: note.slice(0, 200) });
    notify({ kind: "error", stage: "上传", message: `节点侧上传结果不确定 ${streamKey}: ${note}` });
    return { state: "needs_manual", bv: node?.bv };
  }

  // 确认没成(phase=failed / 无落盘 / 读不到)→ 原失败路径。
  const detail = node?.phase === "failed" && node.error ? `,节点结果: ${node.error.slice(0, 120)}` : "";
  jlog(`节点侧确认未完成(落盘=${node?.phase ?? "无"})${detail}`);
  // 节点侧一旦执行过上传就可能已建稿、只是回传失败/超时 ⇒ 一律按「不安全重试」上报
  // (节点名与 reconciler 的 UNSAFE_RETRY_NODES 同名),reconciler 会翻 needs_manual,绝不自动重传。
  ledger.syncNodeState(streamKey, "node_upload", "failed", { error: `节点侧上传失败: ${errMsg.slice(0, 200)}` });
  ledger.syncNodeState(streamKey, "upload_plain", "failed", { error: `节点侧上传失败: ${errMsg.slice(0, 200)}` });
  ledger.markFailed(streamKey, `节点侧上传失败: ${errMsg.slice(0, 200)}`);
  notify({ kind: "error", stage: "同步", message: `节点侧上传失败 ${streamKey}: ${errMsg.slice(0, 200)}` });
  return { state: "failed" };
}

/**
 * 执行节点侧上传。返回非 null = 已由节点完成(调用方直接 return);
 * 返回 null = **回落现状**(能力不足等),调用方继续走 pull 回 master 的常规路径。
 */
export async function tryNodeSideUpload(o: NodeSideUploadArgs): Promise<{ state: JobState; bv?: string } | null> {
  const { streamKey, cfg, winner, winnerMembers, transport, ledger, jlog, notify } = o;

  // 幂等护栏:已建稿(bv 已落库)→ 绝不再建一次。节点侧上传绕过 master 的 append 续跑接缝,
  // 重跑会**重复投稿**(B站不支持改稿件视频内容,只能删稿重传)。宁可转人工,也不冒重复稿的险。
  const existingBv = (ledger.get(streamKey)?.bv ?? "").trim();
  if (existingBv) {
    // issue #91:本场已 done(收尾补跑重入)——稿件是好的,不该转人工也不该告警。
    // 状态机会拒绝 done → needs_manual,但通知不依赖它 → 状态不变、告警每轮照发(刷屏)。
    if (ledger.get(streamKey)?.state === "done") {
      jlog(`节点侧上传跳过:本场已 done 且已建稿(bv=${existingBv}),不重复投稿,不转人工`);
      return { state: "done", bv: existingBv };
    }
    jlog(`节点侧上传跳过:本场已建稿(bv=${existingBv}),绝不重复投稿 → 转人工核对`);
    const moved = ledger.setState(streamKey, "needs_manual", {
      error: `已建稿 bv=${existingBv},节点侧不重复上传;请人工核对分 P`,
    });
    // 状态转换被拒(并发下已被别处改走)→ 不通知:告警必须与台账状态一致。
    if (moved) notify({ kind: "error", stage: "上传", message: `${streamKey} 已建稿(${existingBv}),节点侧跳过上传,请人工核对` });
    return { state: "needs_manual", bv: existingBv };
  }

  // 能力探测:旧 bundle 无 _node-capabilities / 节点缺 biliup / 无 cookie → 回落现状。
  if (!transport.nodeCapabilities || !transport.nodePipeline) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 的 bundle 不支持(_node-pipeline 缺失) → 回落 pull 回 master`);
    return null;
  }
  let caps;
  try {
    caps = await transport.nodeCapabilities();
  } catch (e) {
    jlog(`节点侧上传能力探测失败(${(e as Error)?.message ?? e}) → 回落 pull 回 master`);
    return null;
  }
  // 调用方保证 upload 模式(见 shouldUseNodeSideUpload),这里直接按 upload 校验能力。
  if (!caps.biliup) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 无 biliup → 回落 pull 回 master`);
    return null;
  }
  if (!caps.cookies && !cfg.cookies) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 无 B站 cookie 且 master 未下发 → 回落 pull 回 master`);
    return null;
  }
  // 磁盘水位闸门(issue #8):阈值与 reconciler 的磁盘看门狗同源(cfg.diskMinGB ← hub.config
  // resources.diskMinGB)。低于阈值 → 不选节点侧,回落 pull 回 master 并**记明原因**(绝不静默)。
  // 探测失败(caps.diskFreeGB 缺失/非有限数)→ 不拦(见 diskWatermarkGate 注释:靠看门狗告警兜底)。
  const diskGate = diskWatermarkGate(caps.diskFreeGB, cfg.diskMinGB);
  if (!diskGate.ok) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} ${diskGate.reason} → 回落 pull 回 master`);
    return null;
  }
  jlog(`节点侧上传可用(biliup=${caps.biliup} cookies=${caps.cookies} 磁盘=${fmtFreeGB(caps.diskFreeGB)})→ 节点本地处理,省掉回传`);

  const spec: NodePipelineSpec = {
    streamKey,
    tsFiles: winnerMembers.flatMap((m) => m.rec.tsFiles),
    xmlPath: winner.rec.xmlPath,
    liveTitle: o.earliest?.rec.title,
    startMs: o.earliest?.rec.startMs || o.broadcastStartMs,
    sessionBase: o.earliest?.rec.sessionBase,
    segmentGroupSec: cfg.segmentGroupSec,
    mergeSegments: cfg.steps?.mergeSegments !== false,
    uploadMode: "upload",
    stageDir: cfg.stageDir,
    uploadMeta: cfg.uploadMeta,
    uploadPrivate: cfg.uploadPrivate !== false,
    timeZone: cfg.timeZone,
    minSegmentSec: cfg.minSegmentSec,
    cookies: cfg.cookies || undefined,
    cleanSourceAfterDone: cfg.cleanup?.sourceAfterDone === true,
    cleanStageAfterDone: cfg.cleanup?.stageAfterDone === true,
  };

  // 步骤名用独立的 `node_upload`(不是 `pull`):节点本地 remux + 上传,无录像回传 →
  // 记成 pull 会让队列/台账误报「还在 rsync 回传」。同时写节点表 running,让队列「当前节点」对得上。
  ledger.logStep(streamKey, "node_upload", "start");
  ledger.syncNodeState(streamKey, "node_upload", "running");
  jlog(`节点侧执行: remux + 上传(无录像回传)`);
  const t0 = Date.now();
  let result;
  try {
    result = await transport.nodePipeline(spec);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // ssh rc≠0 / 超时 ≠ 节点没成功:统一收口(handleNodeFailure 会先回读节点落盘结果)。
    return await handleNodeFailure(o, msg);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (!result.ok) {
    const msg = result.error ?? "未知错误";
    return await handleNodeFailure(o, msg, elapsed);
  }

  ledger.logStep(streamKey, "node_upload", "done", `节点侧完成 ${elapsed}s${result.products?.length ? ` · ${result.products.length} 产物` : ""}`);
  jlog(`节点侧完成(${elapsed}s)${result.bv ? ` BV=${result.bv}` : ""}`);

  // 收口(标记 done + 删各成员节点源):与「假失败回读确认成功」共用同一份实现。
  return await finalizeNodeSuccess(o, result.bv ?? "");
}
