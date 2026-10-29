/**
 * verify.ts — **上传后产物完整性核验 + 延迟删源**(plans/030 T11)。
 *
 * 为什么要核验:B站投稿的分 P 数是**隐式成功信号** —— biliup 返回 bv 就退出 0,
 * 但 append 的分 P 可能被 B站拒了/丢了(稿件锁、超限、风控),此时 UI 显示「已上传」,
 * 而源文件该不该删就失去了判据。所以:上传成功后先核验「B站实际分 P 数」,
 * 再决定能不能删源。
 *
 * ## 期望值必须从「实际上提交的段数」推导 —— 不用文件大小上界估
 *
 * 曾考虑用 `splitToSizeLimit` / `uploadBatchSize` / `segmentGroupSec` / `splitGroupsBySession`
 * 反推一个**上界**,评审明确否决:这些参数都会改变实际段数,上界只在极端配置下与实际相等,
 * 常态下必然 mismatch → mismatch 又不删源 → 源越积越多直至磁盘占满(比不做核验更糟)。
 *
 * 唯一可靠基线 = **台账里实际记下 checkpoint 的分 P 数**(`sync_parts`):
 * 每个分 P 成功 append 就写一行,续跑据此幂等跳过。所以
 * `expected = Σ(启用组的 checkpoint 数)`。
 *
 * ## 组名有历史包袱:核验时**同时接受两种拼写**
 *
 * `sync_parts.groupName` 历史上写过的名字有两种:
 *  - 分段路径(`segment-pipeline.ts` 的 `appendSegmentGroup`)写的是**步骤名**:
 *    `plain` / `append_danmu` / `append_livechat`;
 *  - 合并路径(`workflow.ts` 的 `runAppendGroup`)此前**根本不写 sync_parts**,
 *    本次补写时**统一用同名的步骤名**,不另起 `danmu`/`livechat`。
 *
 * 但历史库里可能已存在短名拼写的行,而在途 job 的续跑是按 `doneParts(key, step)` 读的 ——
 * 若核验只认一种拼写,就会**读不到已有行**。故 `partCountOf` 对每个逻辑组**并集**全部别名
 * (段号去重,同一段被两种拼写各记一次也只算一次)。
 */

/** 逻辑组(与台账里的具体拼写无关)。 */
export type VerifyGroup = "plain" | "danmu" | "livechat";

/**
 * 每个逻辑组的 `sync_parts.groupName` 全部已知别名。
 * 主名 = 步骤名(与 segment-pipeline 现状一致);后面是兼容短名。
 * 读写两侧共用这张表 —— 别在别处硬写组名字面量。
 */
export const PART_GROUP_ALIASES: Record<VerifyGroup, readonly string[]> = {
  plain: ["plain"],
  danmu: ["append_danmu", "danmu"],
  livechat: ["append_livechat", "livechat"],
};

/**
 * 写侧要用到的规范组名(= 步骤名,与分段路径 `appendSegmentGroup` 一致)。
 *
 * **从别名表派生而不是另写一份字面量**:读侧认 `append_danmu`、写侧若写成 `danmu`,
 * 核验就会恒 mismatch(且历史行读不到)。派生保证「写的名字永远是读的第一优先名」,
 * 两边不可能漂移。
 */
export const PART_GROUP_CANONICAL: Record<VerifyGroup, string> = {
  plain: PART_GROUP_ALIASES.plain[0],
  danmu: PART_GROUP_ALIASES.danmu[0],
  livechat: PART_GROUP_ALIASES.livechat[0],
};

/** 台账读侧(只要求 `doneParts`,便于单测注入假台账)。 */
export interface PartsReader {
  doneParts(streamKey: string, groupName: string): Set<number>;
}

/** 期望的提交计划:哪些组参与、每个组实际上交了多少分 P。 */
export interface SubmittedPlan {
  /** 各逻辑组的已提交分 P 数(= 台账 checkpoint 数,非上界)。 */
  counts: Record<VerifyGroup, number>;
  /** 该组是否启用(关掉的组不计入期望)。 */
  on: Record<VerifyGroup, boolean>;
}

/**
 * 从台账 checkpoint 推导某逻辑组「实际上提交了多少分 P」。
 * 并集 `PART_GROUP_ALIASES` 的全部拼写(见文件头「历史包袱」段)。
 */
export function partCountOf(ledger: PartsReader, streamKey: string, group: VerifyGroup): number {
  const merged = new Set<number>();
  for (const alias of PART_GROUP_ALIASES[group]) {
    for (const idx of ledger.doneParts(streamKey, alias)) merged.add(idx);
  }
  return merged.size;
}

/** 从台账读取期望提交计划(纯读、无副作用;pipeline 与 reconciler 共用,避免两处各算一份)。 */
export function submittedPlanFromLedger(
  ledger: PartsReader,
  streamKey: string,
  on: Record<VerifyGroup, boolean>,
): SubmittedPlan {
  return {
    counts: {
      plain: partCountOf(ledger, streamKey, "plain"),
      danmu: partCountOf(ledger, streamKey, "danmu"),
      livechat: partCountOf(ledger, streamKey, "livechat"),
    },
    on,
  };
}

/**
 * 期望分 P 数 = Σ(启用组的已提交数)。
 *
 * P1 落在 plain 组(段号 0),所以 plain 组天然 ≥1。返回 0 = **台账零 checkpoint**
 * (本次上线前的合并路径老 job 就是这样)—— 调用方必须把它当「基线缺失,无法核验」,
 * 不能当「期望 0 个分 P」,否则恒 mismatch。
 */
export function expectedPartCount(plan: SubmittedPlan): number {
  let n = 0;
  if (plan.on.plain) n += plan.counts.plain;
  if (plan.on.danmu) n += plan.counts.danmu;
  if (plan.on.livechat) n += plan.counts.livechat;
  return n;
}

/** 核验结论。 */
export type VerifyResult =
  | { kind: "ok"; expected: number; actual: number }
  /** 核验关闭(未注入 countParts)或基线缺失 → 行为与现状一致(照常删源)。 */
  | { kind: "skipped"; reason: "no-countParts" | "no-baseline" }
  /** 实际数与期望不符 → 转人工 + **绝不删源**。 */
  | { kind: "mismatch"; expected: number; actual: number }
  /** 取实际分 P 数失败(`countParts` 返回 null / 抛错)→ **软状态**,下轮补跑再验。 */
  | { kind: "unknown"; reason: string };

/**
 * 纯判定:实际数 vs 期望数。`actual === null` = 取数失败 → `unknown`(软状态,非人工)。
 *
 * `expected <= 0` = 台账无基线 → **跳过核验**而非判 mismatch:
 * 否则本次上线前的所有合并路径老 job 会集体 mismatch → 永不删源 → 磁盘占满。
 */
export function verifyParts(expected: number, actual: number | null): VerifyResult {
  if (actual === null) return { kind: "unknown", reason: "取实际分 P 数失败(可重试)" };
  if (expected <= 0) return { kind: "skipped", reason: "no-baseline" };
  if (actual === expected) return { kind: "ok", expected, actual };
  return { kind: "mismatch", expected, actual };
}

/**
 * 完整核验:读台账 → 算期望 → 取实际 → 判定。
 *
 * `countParts` 是**注入接缝**(orchestrator 绝不能 import @drec/app —— 分层测试会挂):
 * 缺省 `undefined` = 核验关闭;由 cli 注入 `countVideoParts`。
 */
export async function verifyUploaded(
  ledger: PartsReader,
  streamKey: string,
  bv: string,
  on: Record<VerifyGroup, boolean>,
  countParts?: (bv: string) => Promise<number | null>,
  opts: VerifyOpts = {},
): Promise<VerifyResult> {
  if (!countParts) return { kind: "skipped", reason: "no-countParts" };
  const plan = submittedPlanFromLedger(ledger, streamKey, on);
  // **plain 组恒有 P1**:两条路径都在建稿成功时记 plain/0。所以 plain=0 ⟺ 台账里没有本次上传的
  // 基线(本次上线前的合并路径老 job、或续跑只补了 append 的老 job)。
  // 此时若照样拿 Σ(其余组)去比,会得到「期望 2 / 实际 3」的假 mismatch → 全场转人工 + 永不删源,
  // 比不做核验更糟。故按「无基线」跳过(行为与现状一致)。
  if (plan.counts.plain === 0) return { kind: "skipped", reason: "no-baseline" };
  const expected = expectedPartCount(plan);
  if (expected <= 0) return { kind: "skipped", reason: "no-baseline" };
  return countWithConsistency(expected, bv, countParts, opts);
}

/**
 * 期望分 P 数(台账基线)。0 = 无基线(plain 组恒有 P1,plain=0 说明台账里没有本次上传的 checkpoint:
 * 老 job / 续跑只补 append / 节点侧上传),调用方必须当「无法核验」放行,不能当「期望 0」。
 */
export function expectedPartsFromLedger(
  ledger: PartsReader,
  streamKey: string,
  on: Record<VerifyGroup, boolean>,
): number {
  const plan = submittedPlanFromLedger(ledger, streamKey, on);
  return plan.counts.plain === 0 ? 0 : expectedPartCount(plan);
}

/** 延后回读总窗口默认值(issue #327):即 `sideCheckDelayMs` 缺省,不另设旋钮。 */
export const DEFAULT_READBACK_WINDOW_MS = 10 * 60_000;

/** 各次回读占总窗口的比例(间隔,非累计):10 分钟窗口 = 首读 2 分钟后,再 2/2/4 分钟后重读(累计 2/4/6/10 分钟)。 */
const READBACK_SPLIT = [0.2, 0.2, 0.2, 0.4] as const;

/** 回读前的等待序列(ms)。 */
export function readbackDelays(windowMs: number): number[] {
  const w = Math.max(0, windowMs);
  return READBACK_SPLIT.map((r) => Math.round(w * r));
}

/**
 * 延后多次回读分 P 数(issue #327):每次先等 `readbackDelays` 的一段,再读一次;读到与期望一致立即返回 `ok`。
 * 窗口耗尽仍不符 → 返回**最后一次**结果:`mismatch`(`actual < expected` = 少,`actual > expected` = 可能重复)/
 * `unknown`(最后一次读不到或抛错)。B站列表最终一致:早期的「少」多半是读早了,所以不能只读一次。
 * 不重传、不重试上传,只读。
 */
export async function readbackWithDelays(o: {
  expected: number;
  bv: string;
  countParts: (bv: string) => Promise<number | null>;
  windowMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<VerifyResult> {
  let last: VerifyResult = { kind: "unknown", reason: "未读取" };
  for (const delay of readbackDelays(o.windowMs)) {
    await o.sleep(delay);
    try {
      last = verifyParts(o.expected, await o.countParts(o.bv));
    } catch (e) {
      last = { kind: "unknown", reason: `取实际分 P 数异常: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    if (last.kind === "ok") return last;
  }
  return last;
}

/**
 * 取实际分 P 数,**并等它与期望一致**(B站 `pages` 列表是最终一致的)。
 *
 * ## 为什么必须重试(2026-10-10 实测取证,不是推测)
 * `appendGroup` 返回时 B站**已收下请求**,但 `view?bvid=` 的 `pages` **还没刷新**。
 * 实测两场都在**最后一个 append 成功后 0.5~0.6 秒**就核验:`douyin:347071634383:2026-10-11`
 * append 收于 00:51:34.712、核验判于 00:51:35.217 → 只看到 P1 → 判「期望 3 / 实际 1」。
 * 而 B站上分 P 其实**齐全**(`BV1pqpL6kEeH` 实查 3 个、`BV1hWpL6HEWr` 实查 2 个)
 * —— **上传是成功的,是核验读早了**。
 *
 * 代价有三:①13/61 个 job 永久卡人工待办(reconciler **不重跑 `needs_manual`**,防重传重复稿,
 * 所以不会自愈);②源文件不删 → 每场几 GB 持续累积;③待人工列表被噪声淹没,真故障反而看不见。
 *
 * ## 策略
 * 不一致 → **重查**(默认最多 5 次、间隔 3s 起步退避,覆盖 B站 1~2s 的同步窗口),
 * 只有**稳定不一致**(重试耗尽仍不符)才判 `mismatch` → 保留源 + 转人工。
 * 取数失败(`null`/抛错)沿用既有语义 = `unknown` 软状态(可被 reconciler 补跑)。
 *
 * @param sleep 休眠注入(测试用 no-op;与 pipeline 的 `deps.sleep` 同一注入法)。
 */
async function countWithConsistency(
  expected: number,
  bv: string,
  countParts: (bv: string) => Promise<number | null>,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  const maxTries = Math.max(1, opts.maxVerifyTries ?? DEFAULT_MAX_TRIES);
  const baseDelay = Math.max(0, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: VerifyResult | null = null;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    let actual: number | null;
    try {
      actual = await countParts(bv);
    } catch (e) {
      // 抛错与 null 同义 = 软状态:一次网络抖动绝不该吃掉整场(转人工 = 要人工重传)。
      return { kind: "unknown", reason: `取实际分 P 数异常: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    const r = verifyParts(expected, actual);
    last = r;
    if (r.kind !== "mismatch") return r; // ok / unknown / skipped → 立即定案
    if (attempt < maxTries) await sleep(Math.round(baseDelay * attempt));
  }
  return last!;
}

/** 重查次数/间隔默认值:5 次 × 3s 起步退避(累计 ~45s),覆盖 B站 1~2s 同步窗口数倍余量。 */
const DEFAULT_MAX_TRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 3_000;

/** `verifyUploaded` 的可调项(测试注入 no-op 休眠/缩短间隔;生产用默认值)。 */
export interface VerifyOpts {
  /** 不一致时最多重查几次(含第一次)。默认 5。 */
  maxVerifyTries?: number;
  /** 重查间隔基数(ms);第 n 次等 `retryDelayMs * n`。默认 3000。 */
  retryDelayMs?: number;
  /** 休眠注入(测试用 no-op)。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * mismatch 时是否**阻塞**(转 needs_manual + 保留源)。
   * 缺省 = {@link DEFAULT_VERIFY_BLOCKING}(false)。注意:收口(finalizeAfterUpload)不读取该策略:
   * issue #327 起删源前的延后回读自成闸门({@link readbackWithDelays});此开关仅保留给 verify 模块自身的纯函数与测试。
   * 传 true 恢复旧行为。
   */
  blocking?: boolean;
}

/**
 * **核验是否阻塞**(2026-10-10 起默认 **false = 只观察**)。
 *
 * ## 为什么降级(实测取证,不是拍脑袋)
 * 核验的前提是「biliup 可能退出 0 但实际没提交分P」。但全 61 个 job 里:
 * - 判过 mismatch 的**只有 2 个**;
 * - 这 2 个经**实查 B站,分P 其实都齐全**(`BV1pqpL6kEeH` 3 个、`BV1hWpL6HEWr` 2 个)
 *   —— 是核验在 append 成功后 0.5 秒就去查 B站、而 B站还没同步,读到了旧值。
 *
 * 即:**核验从未抓到过一次真实失败,只误伤了成功的上传**。而它的代价很实:
 * 永久 `needs_manual`(reconciler **不重跑** needs_manual,防重传重复稿 → 不会自愈)
 * + 源文件不删(每场几 GB)。
 *
 * ## 现在的行为(观察期)
 * 仍**照常核验并记录**(台账 + job.log + `clean_verify` 步骤,期望/实际都留痕),
 * 但**不再**把 job 打成 `needs_manual`、**不再**阻止删源。
 * 观察期要攒的数据 = 「biliup 退出码 0,但 B站分P 最终不符」的**真实发生率**:
 * 攒够样本后用**真实分布**回答「B站同步要等多久」,再决定要不要升回硬验收。
 *
 * ## 怎么翻回去
 * (收口不据此阻塞:删源前的闸门是 issue #327 的延后多次回读,与本开关无关。)
 */
const DEFAULT_VERIFY_BLOCKING = false;

/**
 * 当前策略下 mismatch 是否**阻塞**(转人工 + 保留源)。
 * 调用方(pipeline 的 finalizeAfterUpload)据此决定走「观察期只记录」还是「旧行为」。
 * 单一真理源:策略只在这里判一次,不在 pipeline / reconciler 各写一遍。
 */
export function verifyBlocksOnMismatch(): boolean {
  return DEFAULT_VERIFY_BLOCKING;
}

/** 该结论是否**可重试**(目前只有软状态 unknown;reconciler 据此补跑)。 */
export function isRetryableVerify(r: VerifyResult): boolean {
  return r.kind === "unknown";
}

/**
 * 是否**允许删源**:只有 mismatch / unknown(软状态,数据还没被删)不允许。
 * skipped(核验关闭 / 无基线)与 ok 都允许 —— 与本次上线前的行为一致。
 *
 * **观察期({@link DEFAULT_VERIFY_BLOCKING}=false)下 mismatch 也允许删源**:
 * 核验只作记录,不再因为「读到了还没同步的分P 数」把源全留着(实测这只会
 * 误伤成功的上传、让磁盘持续涨)。真丢分P 的兜底 = biliup 退出码非 0(上传即失败重试),
 * 不依赖这次事后查询。
 */
export function verifyAllowsCleanup(r: VerifyResult): boolean {
  if (!DEFAULT_VERIFY_BLOCKING && r.kind === "mismatch") return true;
  return r.kind === "ok" || r.kind === "skipped";
}

/** 统一措辞(单一真理源:pipeline 与 reconciler 都调它,不在两处各写一份)。 */
export function verifyMessage(r: VerifyResult, streamKey: string, bv: string): string {
  switch (r.kind) {
    case "ok": return `${streamKey} 产物核验通过(${r.actual} 个分 P)`;
    case "skipped": return `${streamKey} 跳过产物核验(${r.reason})`;
    case "mismatch":
      return `${streamKey} 分 P 数不符:期望 ${r.expected} 实际 ${r.actual}(bv=${bv}) —— 请人工核对`;
    case "unknown": return `${streamKey} 产物核验未得出结论:${r.reason}`;
  }
}
