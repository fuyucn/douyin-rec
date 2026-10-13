import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 强制「核验阻塞」策略(生产默认=观察期 false):覆盖 finalizeAfterUpload 的 done → needs_manual 分支。
vi.mock("../../packages/orchestrator/src/verify.js", async (orig) => ({
  ...(await orig<typeof import("../../packages/orchestrator/src/verify.js")>()),
  verifyBlocksOnMismatch: () => true,
}));

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

describe("finalizeAfterUpload 核验阻塞 × 真实 SyncLedger", () => {
  it("已 markDone 的场,分 P 不符 → 台账真转 needs_manual(force),返回 verifyBlocked,无非法转换 warn", async () => {
    ledger.upsertPending(KEY);
    for (const s of ["syncing", "merging", "uploading"] as const) ledger.setState(KEY, s);
    ledger.markPartDone(KEY, "plain", 0);          // 基线:期望 1 个分 P
    ledger.markDone(KEY, "BV1");
    expect(ledger.get(KEY)?.state).toBe("done");

    const cleanupSources = vi.fn(async () => ({ ok: true }) as never);
    const notify = vi.fn();
    const r = await finalizeAfterUpload({
      streamKey: KEY, bv: "BV1", log: () => {}, notify, cleanupSources,
      deps: { ledger, countParts: async () => 3, sleep: async () => {} } as unknown as PipelineDeps,
      on: { plain: true, danmu: false, livechat: false },
    });

    expect(r.verifyBlocked).toBe(true);
    expect(ledger.get(KEY)?.state).toBe("needs_manual");   // 台账与返回值一致
    expect(ledger.get(KEY)?.error).toContain("产物核验失败");
    expect(cleanupSources).not.toHaveBeenCalled();          // 保留全部源
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
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
