import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_JOB_STATES } from "@drec/core";
import { ALLOWED_TRANSITIONS, SyncLedger, isTransitionAllowed } from "../../packages/orchestrator/src/ledger.js";

let dir: string;
let dbPath: string;
let ledger: SyncLedger;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-trans-"));
  dbPath = join(dir, "sync.db");
  ledger = new SyncLedger(dbPath);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 直接写库造出任意旧状态(绕过白名单,模拟升级前留下的行)。 */
function seedRaw(key: string, state: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO sync_jobs(streamKey,state,fails,updatedAt) VALUES(?,?,0,1)").run(key, state);
  db.close();
}

describe("SyncLedger 状态转换白名单(#26)", () => {
  it("白名单覆盖全部状态,且目标都是合法状态", () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...HUB_JOB_STATES].sort());
    for (const tos of Object.values(ALLOWED_TRANSITIONS)) for (const t of tos) expect(HUB_JOB_STATES).toContain(t);
  });

  it("合法主线:pending→syncing→merging→uploading→done,每步返回 true 并记事件", () => {
    ledger.upsertPending("k");
    expect(ledger.setState("k", "syncing", { winnerWorker: "w1" })).toBe(true);
    expect(ledger.setState("k", "merging")).toBe(true);
    expect(ledger.setState("k", "uploading")).toBe(true);
    expect(ledger.markDone("k", "BV1")).toBe(true);
    expect(ledger.get("k")).toMatchObject({ state: "done", bv: "BV1", winnerWorker: "w1" });
    expect(ledger.getEvents("k").map((e) => e.state)).toEqual(["pending", "syncing", "merging", "uploading", "done"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("合法重入:failed→failed(fails 自增)、failed→syncing、→needs_manual、needs_manual→retrying→done", () => {
    ledger.upsertPending("k");
    expect(ledger.markFailed("k", "e1")).toBe(true);
    expect(ledger.markFailed("k", "e2")).toBe(true);
    expect(ledger.get("k")?.fails).toBe(2);
    expect(ledger.setState("k", "syncing")).toBe(true);
    expect(ledger.markFailed("k", "e3")).toBe(true);
    expect(ledger.setState("k", "needs_manual", { error: "stop" })).toBe(true);
    expect(ledger.setState("k", "retrying")).toBe(true);
    expect(ledger.markDone("k", "BV2")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("needs_manual 经人工 recheck 可直接 markDone", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual");
    expect(ledger.markDone("k", "BV3")).toBe(true);
    expect(ledger.get("k")?.state).toBe("done");
  });

  it("done 是终态:任何非 done 目标都被拒,不写库、warn、返回 false、不 throw", () => {
    ledger.upsertPending("k");
    ledger.markDone("k", "BV1");
    const before = ledger.get("k")!;
    const events = ledger.getEvents("k").length;
    const targets = HUB_JOB_STATES.filter((s) => s !== "done");
    for (const to of targets) expect(ledger.setState("k", to, { error: "x", winnerWorker: "w" })).toBe(false);
    expect(ledger.markFailed("k", "late")).toBe(false);
    expect(ledger.get("k")).toEqual(before);
    expect(ledger.getEvents("k").length).toBe(events);
    expect(warn).toHaveBeenCalledTimes(targets.length + 1);
  });

  it("done→done 幂等收尾(补跑清理 / 续跑)仍允许", () => {
    ledger.upsertPending("k");
    ledger.markDone("k", "BV1");
    expect(ledger.markDone("k", "BV1")).toBe(true);
    expect(ledger.setState("k", "done")).toBe(true);
  });

  it("done 场被迟到的 setState(needs_manual) 改写会被拒(abort 路径回归)", () => {
    ledger.upsertPending("k");
    ledger.markDone("k", "BV1");
    expect(ledger.setState("k", "needs_manual", { error: "用户停止" })).toBe(false);
    expect(ledger.get("k")).toMatchObject({ state: "done", error: null });
  });

  it("needs_manual 不得被迟到的 markFailed 改回 failed(否则 reconciler 会自动重跑已停止的场)", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual", { error: "用户停止" });
    expect(ledger.markFailed("k", "late error")).toBe(false);
    expect(ledger.get("k")).toMatchObject({ state: "needs_manual", error: "用户停止", fails: 0 });
  });

  it("非法转换(进行中状态倒退)不改 updatedAt、不记事件、不改 error/winnerWorker", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "syncing", { winnerWorker: "w1" });
    ledger.setState("k", "merging");
    const before = ledger.get("k")!;
    const events = ledger.getEvents("k").length;
    expect(ledger.setState("k", "syncing", { winnerWorker: "w2", error: "boom" })).toBe(false);
    expect(ledger.get("k")).toEqual(before);
    expect(ledger.get("k")?.updatedAt).toBe(before.updatedAt);
    expect(ledger.getEvents("k").length).toBe(events);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("merging → syncing");
  });

  it("done→retrying 默认被拒;{ force: true } 放行(人工重跑),之后正常流转", () => {
    ledger.upsertPending("k");
    ledger.markDone("k", "");
    expect(ledger.setState("k", "retrying")).toBe(false);
    expect(ledger.get("k")?.state).toBe("done");
    expect(ledger.setState("k", "retrying", {}, { force: true })).toBe(true);
    expect(ledger.get("k")?.state).toBe("retrying");
    expect(ledger.markFailed("k", "node failed")).toBe(true); // 重跑失败不再需要 force
    expect(ledger.getEvents("k").map((e) => e.state)).toEqual(["pending", "done", "retrying", "failed"]);
  });

  it("无此 job:不写库、不留孤儿事件、返回 false", () => {
    expect(ledger.setState("ghost", "syncing")).toBe(false);
    expect(ledger.markDone("ghost", "BV")).toBe(false);
    expect(ledger.markFailed("ghost", "e")).toBe(false);
    expect(ledger.get("ghost")).toBeNull();
    expect(ledger.getEvents("ghost")).toEqual([]);
  });

  it("CAS:读到旧状态后被并发改走 → 写入被拒而不是盲覆盖", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "syncing");
    const realGet = ledger.get.bind(ledger);
    // 模拟另一路径在本次「读状态」与「写库」之间把 job 标成 done。
    vi.spyOn(ledger, "get").mockImplementationOnce((key: string) => {
      const snap = realGet(key);
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE sync_jobs SET state='done' WHERE streamKey=?").run(key);
      db.close();
      return snap;
    });
    expect(ledger.setState("k", "merging")).toBe(false);
    expect(ledger.get("k")?.state).toBe("done");
  });

  describe("旧库向后兼容", () => {
    it("库里的非法/未知状态行仍可读(get / listRecent / listActive)", () => {
      seedRaw("legacy", "weird_old_state");
      expect(ledger.get("legacy")?.state).toBe("weird_old_state");
      expect(ledger.listRecent().map((r) => r.streamKey)).toContain("legacy");
      expect(ledger.listActive().map((r) => r.streamKey)).toContain("legacy");
    });

    it("未知旧状态可被改写成合法状态(自愈),不会永久卡死", () => {
      seedRaw("legacy", "weird_old_state");
      expect(isTransitionAllowed("weird_old_state", "failed")).toBe(true);
      expect(ledger.markFailed("legacy", "recovered")).toBe(true);
      expect(ledger.get("legacy")?.state).toBe("failed");
    });

    it("既有库的 done 行(含无 bv 的 stage 收口)同样受终态保护", () => {
      seedRaw("old-done", "done");
      expect(ledger.setState("old-done", "merging")).toBe(false);
      expect(ledger.get("old-done")?.state).toBe("done");
    });
  });
});

describe("needs_manual review mark (issue #312)", () => {
  const acked = (k: string) => ledger.get(k)?.ackedAt ?? null;

  it("ackManual only touches needs_manual rows and keeps state, events and updatedAt", () => {
    ledger.upsertPending("k");
    expect(ledger.ackManual("k", "n")).toBe(false);
    expect(acked("k")).toBeNull();
    ledger.setState("k", "needs_manual", { error: "e" });
    const before = ledger.get("k")!;
    const events = ledger.getEvents("k").length;
    expect(ledger.ackManual("k", "n")).toBe(true);
    expect(ledger.get("k")).toMatchObject({ state: "needs_manual", error: "e", ackNote: "n", updatedAt: before.updatedAt });
    expect(acked("k")).not.toBeNull();
    expect(ledger.getEvents("k")).toHaveLength(events);
    expect(ledger.ackManual("missing", "n")).toBe(false);
  });

  it("re-asserting the same needs_manual reason keeps the mark", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual", { error: "e" });
    ledger.ackManual("k", "n");
    expect(ledger.setState("k", "needs_manual", { error: "e" })).toBe(true);
    expect(acked("k")).not.toBeNull();
  });

  it("a new needs_manual reason reopens the case", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual", { error: "e" });
    ledger.ackManual("k", "n");
    ledger.setState("k", "needs_manual", { error: "other" });
    expect(acked("k")).toBeNull();
    expect(ledger.get("k")?.ackNote ?? null).toBeNull();
  });

  it("leaving needs_manual (manual retry) drops the mark, so a later needs_manual is a fresh case", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual", { error: "e" });
    ledger.ackManual("k", "n");
    ledger.setState("k", "retrying");
    expect(acked("k")).toBeNull();
    ledger.setState("k", "needs_manual", { error: "e" });
    expect(acked("k")).toBeNull();
  });

  it("a rejected transition leaves the mark alone", () => {
    ledger.upsertPending("k");
    ledger.setState("k", "needs_manual", { error: "e" });
    ledger.ackManual("k", "n");
    expect(ledger.markFailed("k", "late")).toBe(false);
    expect(acked("k")).not.toBeNull();
  });

  it("migrates an old ledger without the columns", () => {
    ledger.close();
    const old = join(dir, "old.db");
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL, winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, startMs INTEGER, updatedAt INTEGER NOT NULL)");
    db.prepare("INSERT INTO sync_jobs(streamKey,state,error,updatedAt) VALUES(?,?,?,1)").run("k", "needs_manual", "e");
    db.close();
    ledger = new SyncLedger(old);
    expect(ledger.get("k")?.ackedAt ?? null).toBeNull();
    expect(ledger.ackManual("k", "n")).toBe(true);
    expect(ledger.get("k")?.ackNote).toBe("n");
  });
});
