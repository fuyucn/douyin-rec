/**
 * web/api/proc.ts — 处理任务表端点(plans/036 T3)。
 *
 *   GET  /api/proc/active → 本节点任务表快照 `ProcActiveDTO`(running/pending/leaseAlive 按 kind)
 *   POST /api/proc/purge  → 人工清理 failed 行(`{purgeFailed:true}`;uncertain 须先 ack,永不在此删)
 *
 * 与 maintenance 同形:直接构造 handler(不进 `makeApi`),依赖由 serve 注入;未注入(runner 起不来 /
 * 测试)→ 503 显式不可用,而非空 200。
 */
import type { ProcActiveDTO } from "@drec/core";
import type { ApiResult } from "./types.js";

export interface ProcApiDeps {
  active?: () => ProcActiveDTO;
  purge?: (o: { purgeFailed: boolean }) => { deleted: number };
}

export function buildProc(deps: ProcApiDeps): {
  procActive(): ApiResult;
  procPurge(input: { purgeFailed?: boolean }): ApiResult;
} {
  const unavailable = (): ApiResult => ({ status: 503, body: { error: "处理任务表不可用(proc-queue 未启动)" } });
  return {
    procActive(): ApiResult {
      return deps.active ? { status: 200, body: deps.active() } : unavailable();
    },
    procPurge(input): ApiResult {
      if (!deps.purge) return unavailable();
      return { status: 200, body: deps.purge({ purgeFailed: input.purgeFailed === true }) };
    },
  };
}
