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
  let actual: number | null;
  try {
    actual = await countParts(bv);
  } catch (e) {
    // 抛错与 null 同义 = 软状态:一次网络抖动绝不该吃掉整场(转人工 = 要人工重传)。
    return { kind: "unknown", reason: `取实际分 P 数异常: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
  return verifyParts(expected, actual);
}

/** 该结论是否**可重试**(目前只有软状态 unknown;reconciler 据此补跑)。 */
export function isRetryableVerify(r: VerifyResult): boolean {
  return r.kind === "unknown";
}

/**
 * 是否**允许删源**:只有 mismatch / unknown(软状态,数据还没被删)不允许。
 * skipped(核验关闭 / 无基线)与 ok 都允许 —— 与本次上线前的行为一致。
 */
export function verifyAllowsCleanup(r: VerifyResult): boolean {
  return r.kind === "ok" || r.kind === "skipped";
}

/** 统一措辞(单一真理源:pipeline 与 reconciler 都调它,不在两处各写一份)。 */
export function verifyMessage(r: VerifyResult, streamKey: string, bv: string): string {
  switch (r.kind) {
    case "ok": return `${streamKey} 产物核验通过(${r.actual} 个分 P),已删源`;
    case "skipped": return `${streamKey} 跳过产物核验(${r.reason}),按现状清理`;
    case "mismatch":
      return `${streamKey} 分 P 数不符:期望 ${r.expected} 实际 ${r.actual}(bv=${bv}) —— 已保留全部源,请人工核对`;
    case "unknown": return `${streamKey} 产物核验待重试:${r.reason}`;
  }
}
