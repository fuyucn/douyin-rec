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

describe("finalizeAfterUpload read-back gate x real SyncLedger (#327)", () => {
  const on = { plain: true, danmu: false, livechat: false };
  const seedUploading = (): void => {
    ledger.upsertPending(KEY);
    for (const s of ["syncing", "merging", "uploading"] as const) ledger.setState(KEY, s);
    ledger.markPartDone(KEY, "plain", 0); // baseline: 1 part expected
  };

  it("job stays uploading while waiting; done only after the gate passes (late correct read)", async () => {
    seedUploading();
    const seen: string[] = [];
    let reads = 0;
    const cleanupSources = vi.fn(async () => ({ ok: true }) as never);
    const notify = vi.fn();
    await finalizeAfterUpload({
      streamKey: KEY, bv: "BV1", log: () => {}, notify, cleanupSources, on,
      deps: {
        ledger, sleep: async () => { seen.push(String(ledger.get(KEY)?.state)); },
        countParts: async () => (++reads < 3 ? 0 : 1),
      } as unknown as PipelineDeps,
      commitDone: () => { ledger.markDone(KEY, "BV1"); },
    });
    expect(seen.every((st) => st === "uploading")).toBe(true);
    expect(ledger.get(KEY)?.state).toBe("done");
    expect(cleanupSources).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("persistent short on a not-yet-done job -> needs_manual via normal transition, error carries expected/read-back, sources kept", async () => {
    seedUploading();
    const cleanupSources = vi.fn(async () => ({ ok: true }) as never);
    const notify = vi.fn();
    const commit = vi.fn();
    await finalizeAfterUpload({
      streamKey: KEY, bv: "BV1", log: () => {}, notify, cleanupSources, on, commitDone: commit,
      deps: { ledger, countParts: async () => 0, sleep: async () => {} } as unknown as PipelineDeps,
    });
    expect(ledger.get(KEY)?.state).toBe("needs_manual");
    expect(ledger.get(KEY)?.error).toMatch(/期望 1.*回读 0/);
    expect(commit).not.toHaveBeenCalled();
    expect(cleanupSources).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("already-done job (cleanup backfill), persistent mismatch -> forced to needs_manual, sources kept, no illegal-transition warn", async () => {
    seedUploading();
    ledger.markDone(KEY, "BV1");
    const cleanupSources = vi.fn(async () => ({ ok: true }) as never);
    const notify = vi.fn();
    await finalizeAfterUpload({
      streamKey: KEY, bv: "BV1", log: () => {}, notify, cleanupSources, on,
      deps: { ledger, countParts: async () => 3, sleep: async () => {} } as unknown as PipelineDeps,
    });
    expect(ledger.get(KEY)?.state).toBe("needs_manual");
    expect(cleanupSources).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
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
