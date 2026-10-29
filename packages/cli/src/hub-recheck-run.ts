/**
 * hub-recheck-run.ts — T32 重核工具的 CLI 入口(dry-run 默认)。
 *
 * 用法:
 *   node dist/douyin-rec.mjs hub recheck-verify                # dry-run:只打印
 *   node dist/douyin-rec.mjs hub recheck-verify --apply       # 真翻 needs_manual → done
 *   node dist/douyin-rec.mjs hub recheck-verify --key <streamKey>   # 只查某一场
 *
 * 安全护栏见 hub-recheck-verify.ts 顶部;**删源不在本工具范围内** —— 翻转后由既有
 * cleanup 路径处理(且需要独立的开关),本工具只改台账状态。
 */
import { recheckNeedsManual, productionDeps, type RecheckOutcome } from "./hub-recheck-verify.js";
import { SyncLedger } from "@drec/orchestrator";
import { resolveDbPath } from "@drec/app";
import { rootConfigDir } from "@drec/app";
import { join } from "node:path";

export async function runRecheck(opts: { apply: boolean; keys?: string[]; cookies?: string }): Promise<RecheckOutcome[]> {
  // 台账路径与 serve.ts 同推导(<db>-sync.db);cookies 用数据根下的 hub 权威那份。
  const dbPath = resolveDbPath().replace(/\.db$/, "-sync.db");
  const cookies = opts.cookies ?? join(rootConfigDir(), "biliup", "cookies.json");
  const ledger = new SyncLedger(dbPath);
  // 默认只查 needs_manual(工具内部再按错误文本二次过滤,真故障自动跳过)。
  let keys = opts.keys;
  if (!keys?.length) {
    keys = ledger.listKeys()
      .map((k) => k.streamKey)
      .filter((k) => ledger.get(k)?.state === "needs_manual");
  }
  const results = await recheckNeedsManual(keys, productionDeps(ledger, cookies));
  for (const r of results) {
    const mark = r.verdict === "flip-to-done" && opts.apply ? "→ 已翻转 done" : "";
    console.log(`[${r.verdict}] ${r.streamKey}  期望${r.expected}/实际${r.actual ?? "?"}  ${r.why} ${mark}`);
  }
  const flips = results.filter((r) => r.verdict === "flip-to-done");
  if (flips.length && opts.apply) {
    for (const r of flips) if (r.bv) ledger.markDone(r.streamKey, r.bv);
    console.log(`\n已翻转 ${flips.length} 个 needs_manual → done(B站实查分P 与台账一致)。`);
    console.log("注意:源文件清理由既有 cleanup 路径处理,本工具不删源。");
  } else if (flips.length) {
    console.log(`\n(dry-run)有 ${flips.length} 个可翻转为 done;加 --apply 生效。`);
  }
  const skipped = results.filter((r) => r.verdict === "skip");
  if (skipped.length) console.log(`跳过 ${skipped.length} 个(非核验失败/无 bv/无基线 —— 真故障未被触碰)。`);
  return results;
}
