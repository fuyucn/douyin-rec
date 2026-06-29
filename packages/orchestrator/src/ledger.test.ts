import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLedger } from "./ledger.js";

function fresh(): SyncLedger { return new SyncLedger(join(mkdtempSync(join(tmpdir(), "led-")), "j.db")); }

describe("SyncLedger", () => {
  it("upsertPending 首次 isNew=true，再次 false（幂等去重）", () => {
    const l = fresh();
    expect(l.upsertPending("k1").isNew).toBe(true);
    expect(l.upsertPending("k1").isNew).toBe(false);
    l.close();
  });
  it("已 done 的作业不被 upsertPending 重置", () => {
    const l = fresh();
    l.upsertPending("k1"); l.markDone("k1", "BVxxx");
    l.upsertPending("k1");
    expect(l.get("k1")?.state).toBe("done");
    expect(l.get("k1")?.bv).toBe("BVxxx");
    l.close();
  });
  it("setState 写状态 + 错误", () => {
    const l = fresh();
    l.upsertPending("k1"); l.setState("k1", "failed", { error: "boom" });
    expect(l.get("k1")?.state).toBe("failed");
    expect(l.get("k1")?.error).toBe("boom");
    l.close();
  });
  it("recordCandidates 落库 + 标记 winner + 幂等覆盖（选优可复盘）", () => {
    const l = fresh();
    const cands = [
      { tenantId: "local", coverage: 1, durationSec: 20525, startMs: 100, endMs: 20625100, totalGapSec: 0 },
      { tenantId: "vps2", coverage: 1, durationSec: 20503, startMs: 20100, endMs: 20623100, totalGapSec: 0 },
    ];
    l.recordCandidates("douyin:767:2026-06-28", cands, "local");
    const rows = l.getCandidates("douyin:767:2026-06-28");
    expect(rows).toHaveLength(2);
    expect(rows[0].isWinner).toBe(1);          // winner 排最前
    expect(rows[0].tenantId).toBe("local");
    expect(rows[0].durationSec).toBe(20525);
    expect(rows[1].isWinner).toBe(0);
    // 再次写 → 覆盖不重复（PRIMARY KEY streamKey+tenantId）
    l.recordCandidates("douyin:767:2026-06-28", cands, "vps2");
    const again = l.getCandidates("douyin:767:2026-06-28");
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.tenantId === "vps2")?.isWinner).toBe(1);
    l.close();
  });
});
