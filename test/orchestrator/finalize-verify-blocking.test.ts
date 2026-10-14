import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { finalizeAfterUpload, type PipelineDeps } from "../../packages/orchestrator/src/pipeline.js";

const KEY = "douyin:123:2026-10-12";
let dir: string;
let ledger: SyncLedger;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finalize-block-"));
  ledger = new SyncLedger(join(dir, "sync.db"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("finalizeAfterUpload 回读不阻塞 × 真实 SyncLedger(#92)", () => {
  it("已 markDone 的场,回读分 P 与期望不符 → 台账仍 done、照常清理,无非法转换 warn;clean_verify 记 done", async () => {
    ledger.upsertPending(KEY);
    for (const s of ["syncing", "merging", "uploading"] as const) ledger.setState(KEY, s);
    ledger.markPartDone(KEY, "plain", 0);          // 基线:期望 1 个分 P
    ledger.markDone(KEY, "BV1");
    expect(ledger.get(KEY)?.state).toBe("done");

    const cleanupSources = vi.fn(async () => ({ ok: true }) as never);
    const notify = vi.fn();
    await finalizeAfterUpload({
      streamKey: KEY, bv: "BV1", log: () => {}, notify, cleanupSources,
      deps: { ledger, countParts: async () => 3, sleep: async () => {}, scheduleSideCheck: () => {} } as unknown as PipelineDeps,
      on: { plain: true, danmu: false, livechat: false },
    });

    expect(ledger.get(KEY)?.state).toBe("done");            // 不再转人工
    expect(cleanupSources).toHaveBeenCalledTimes(1);        // 照常清理
    expect(ledger.getNodeStates(KEY).find((n) => n.node === "clean_verify")?.state).toBe("done");
    expect(notify).not.toHaveBeenCalled();                  // 告警只在延迟后的旁路校验里发
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("advanceState:done 场补跑", () => {
  it("done 时静默跳过(不改库、不 warn);非 done 照常推进", () => {
    ledger.upsertPending(KEY);
    expect(ledger.advanceState(KEY, "syncing")).toBe(true);
    ledger.markDone(KEY, "BV1");
    expect(ledger.advanceState(KEY, "merging")).toBe(false);
    expect(ledger.advanceState(KEY, "uploading")).toBe(false);
    expect(ledger.get(KEY)?.state).toBe("done");
    expect(warn).not.toHaveBeenCalled();
  });
});
