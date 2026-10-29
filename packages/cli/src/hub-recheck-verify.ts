/**
 * hub-recheck-verify.ts — **一次性重核工具**(T32):把「假 mismatch」的 needs_manual job 翻回 done。
 *
 * ## 为什么需要(2026-10-10 实测取证)
 * 核验在最后一个 append 成功后 **0.5~0.6 秒**就去查 `view?bvid=`,而 B站 `pages` 还没同步 →
 * 判「期望 N / 实际 1」→ 永久 `needs_manual` + **保留全部源**。
 * 实查那些稿件在 B站上分 P 其实**齐全**(`BV1pqpL6kEeH` 3 个、`BV1hWpL6HEWr` 2 个)
 * —— 上传是成功的,是核验读早了。
 *
 * ## 为什么需要独立工具而不是等 reconciler
 * `reconciler` **只重跑 `failed`,不重跑 `needs_manual`**(设计如此:重传会产生重复稿)。
 * 所以这批 job 不会自愈,磁盘也一直涨 —— 必须有人/有工具按**新口径**重新判定一次。
 *
 * ## 安全边界(三条硬护栏,缺一不可)
 * 1. **只处理 `needs_manual`**,且**错误文本必须匹配分P 核验失败**(其它 needs_manual
 *    ——如真故障 `rsync rc=12`—— 一律跳过,绝不误伤);
 * 2. **只读 B站 + 只写本地台账**:不重传、不 append、不动任何源文件。翻转后的删源
 *    交给既有的 cleanup 逻辑(需显式 `--apply-cleanup` 才会真删,默认 dry-run);
 * 3. **默认 dry-run**:不加 `--apply` 只打印将要做什么,必须显式 `--apply` 才落库。
 */
import type { SyncLedger } from "@drec/orchestrator";
import { countVideoParts } from "@drec/app";
import { submittedPlanFromLedger, expectedPartCount } from "@drec/orchestrator";

/** 核验失败的错误文本特征(与 verify.ts 的 verifyMessage 前缀一致)。 */
const VERIFY_ERR = /分 P 数不符|产物核验失败/;

export interface RecheckOutcome {
  streamKey: string;
  bv: string | null;
  expected: number;
  actual: number | null;
  verdict: "flip-to-done" | "still-mismatch" | "unknown" | "skip";
  why: string;
}

export interface RecheckDeps {
  ledger: SyncLedger;
  /** 查某稿件的实际分 P 数(注入以便测试;生产 = countVideoParts)。 */
  countParts: (bv: string) => Promise<number | null>;
  /** 该房间启用了哪些产出组(决定期望值口径);缺省按台账里出现过的组全开。 */
  groupsOn?: (streamKey: string) => Record<"plain" | "danmu" | "livechat", boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxTries?: number;
  retryDelayMs?: number;
}

/** 只处理「核验失败」的 needs_manual;其它 needs_manual 一律 skip(护栏 1)。 */
function isVerifyFailure(job: { state: string; error?: string | null }): boolean {
  return job.state === "needs_manual" && !!job.error && VERIFY_ERR.test(job.error);
}

export async function recheckNeedsManual(
  streamKeys: string[],
  deps: RecheckDeps,
): Promise<RecheckOutcome[]> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxTries = Math.max(1, deps.maxTries ?? 3);
  const baseDelay = Math.max(0, deps.retryDelayMs ?? 3_000);
  const out: RecheckOutcome[] = [];

  for (const streamKey of streamKeys) {
    const job = deps.ledger.get(streamKey);
    if (!job) {
      out.push({ streamKey, bv: null, expected: 0, actual: null, verdict: "skip", why: "job 不存在" });
      continue;
    }
    if (!isVerifyFailure(job)) {
      out.push({
        streamKey, bv: job.bv ?? null, expected: 0, actual: null, verdict: "skip",
        why: `非核验失败(护栏:不碰真故障)state=${job.state} err=${(job.error ?? "").slice(0, 60)}`,
      });
      continue;
    }
    if (!job.bv) {
      out.push({ streamKey, bv: null, expected: 0, actual: null, verdict: "skip", why: "无 bv(未建稿,无法核验)" });
      continue;
    }

    const on = deps.groupsOn?.(streamKey) ?? allGroupsOnFromLedger(deps.ledger, streamKey);
    const plan = submittedPlanFromLedger(deps.ledger, streamKey, on);
    if (plan.counts.plain === 0) {
      out.push({ streamKey, bv: job.bv, expected: 0, actual: null, verdict: "skip", why: "无 plain 基线(跳过核验口径)" });
      continue;
    }
    const expected = expectedPartCount(plan);
    if (expected <= 0) {
      out.push({ streamKey, bv: job.bv, expected: 0, actual: null, verdict: "skip", why: "期望 0(无基线)" });
      continue;
    }

    // 与修好的 verifyUploaded 同口径:不一致要**重查**(B站 pages 最终一致)。
    let actual: number | null = null;
    for (let i = 1; i <= maxTries; i++) {
      actual = await deps.countParts(job.bv);
      if (actual === expected) break;
      if (i < maxTries) await sleep(Math.round(baseDelay * i));
    }

    if (actual === null) {
      out.push({ streamKey, bv: job.bv, expected, actual: null, verdict: "unknown", why: "取实际分 P 数失败(不翻,留给人工)" });
    } else if (actual === expected) {
      out.push({ streamKey, bv: job.bv, expected, actual, verdict: "flip-to-done", why: `B站实查 ${actual} 个分 P = 台账期望 ${expected} → 之前是假 mismatch` });
    } else {
      out.push({ streamKey, bv: job.bv, expected, actual, verdict: "still-mismatch", why: `重查后仍不符(B站 ${actual} vs 期望 ${expected})—— 是真问题,保持 needs_manual` });
    }
  }
  return out;
}

/** 没给 groupsOn 时:台账里**出现过**的组算启用(与 pipeline 的 `on` 尽量对齐)。 */
function allGroupsOnFromLedger(ledger: SyncLedger, streamKey: string): Record<"plain" | "danmu" | "livechat", boolean> {
  return {
    plain: true,
    danmu: ledger.doneParts(streamKey, "append_danmu").size > 0 || ledger.doneParts(streamKey, "danmu").size > 0,
    livechat: ledger.doneParts(streamKey, "append_livechat").size > 0 || ledger.doneParts(streamKey, "livechat").size > 0,
  };
}

/** 组装生产用 deps(真实 B站查询 + 真实 cookies 文件路径)。 */
export function productionDeps(ledger: SyncLedger, cookiesPath: string): RecheckDeps {
  return {
    ledger,
    // countVideoParts 自己会读 cookies 文件;这里直接传路径。
    countParts: (bv) => countVideoParts(bv, cookiesPath),
  };
}
