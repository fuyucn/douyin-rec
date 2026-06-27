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
});
