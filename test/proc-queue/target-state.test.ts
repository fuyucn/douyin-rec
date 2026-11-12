// plans/049 §6 stage 3: proc-queue stores an opaque target checkpoint and dual-writes the legacy
// bv / seasonState columns, so new bundles read the checkpoint while old bundles keep working.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ProcQueueStore } from "@drec/proc-queue";
import { SCHEMA_VERSION } from "../../packages/proc-queue/src/schema.js";
import { makeEnv, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

const roots = (): { allowedRoots: string[] } => ({ allowedRoots: [env.root] });

/** Turn a freshly migrated DB into the v5 shape: no targetState column, user_version=5. */
function downgradeToV5(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("ALTER TABLE proc_jobs DROP COLUMN targetState");
  db.exec("PRAGMA user_version=5");
  db.close();
}

const rawRow = (path: string, sql: string, ...args: Array<string | number>): Record<string, unknown> => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).get(...args) as Record<string, unknown>;
  } finally {
    db.close();
  }
};

describe("v6 targetState column", () => {
  it("fresh DB is at SCHEMA_VERSION and exposes the column", () => {
    const s = env.open();
    const r = s.enqueue(env.job("a.ts"), roots());
    expect(r.state).toBe("pending");
    const version = rawRow(env.dbPath, "PRAGMA user_version").user_version;
    expect(Number(version)).toBe(SCHEMA_VERSION);
    const cols = (() => {
      const db = new DatabaseSync(env.dbPath, { readOnly: true });
      try { return (db.prepare("PRAGMA table_info(proc_jobs)").all() as Array<{ name: string }>).map((c) => c.name); } finally { db.close(); }
    })();
    expect(cols).toContain("targetState");
  });

  it("setBv dual-writes: checkpoint and legacy column agree", () => {
    const s = env.open();
    const { jobId } = s.enqueue(env.job("b.ts"), roots());
    expect(s.setBv(jobId, "BV1dual")).toBe(true);
    expect(s.get(jobId)).toMatchObject({
      bv: "BV1dual",
      targetState: { targetId: "bilibili", archiveId: "BV1dual" },
    });
    // Old bundle reads the legacy column only.
    expect(rawRow(env.dbPath, "SELECT bv FROM proc_jobs WHERE jobId=?", jobId).bv).toBe("BV1dual");
  });

  it("setTargetState keeps parts across a later season update", () => {
    const s = env.open();
    const { jobId } = s.enqueue(env.job("c.ts"), roots());
    expect(s.setTargetState(jobId, { targetId: "bilibili", archiveId: "BV1p", parts: 2, season: "pending" })).toBe(true);
    expect(s.setSeasonState(jobId, "done")).toBe(true);
    expect(s.get(jobId)).toMatchObject({
      bv: "BV1p",
      seasonState: "done",
      targetState: { targetId: "bilibili", archiveId: "BV1p", parts: 2, season: "done" },
    });
  });

  it("season without an archive stays on the legacy column", () => {
    const s = env.open();
    const { jobId } = s.enqueue(env.job("d.ts"), roots());
    expect(s.setSeasonState(jobId, "pending")).toBe(true);
    expect(s.get(jobId)).toMatchObject({ seasonState: "pending", targetState: null });
  });

  it("a malformed checkpoint never throws and falls back to the legacy columns", () => {
    const s = env.open();
    const { jobId } = s.enqueue(env.job("e.ts"), roots());
    s.setBvAndSeasonState(jobId, "BV1bad", "pending");
    const db = new DatabaseSync(env.dbPath);
    db.prepare("UPDATE proc_jobs SET targetState=? WHERE jobId=?").run("{not json", jobId);
    db.close();
    expect(s.get(jobId)).toMatchObject({ bv: "BV1bad", seasonState: "pending", targetState: null });

    const db2 = new DatabaseSync(env.dbPath);
    db2.prepare("UPDATE proc_jobs SET targetState=? WHERE jobId=?").run(JSON.stringify({ targetId: "", archiveId: "X" }), jobId);
    db2.close();
    expect(s.get(jobId)?.targetState).toBeNull();
    expect(s.get(jobId)?.bv).toBe("BV1bad");
  });
});

describe("migration and rollback", () => {
  it("a v5 row upgrades in place and stays readable", () => {
    const seed = env.open();
    const { jobId } = seed.enqueue(env.job("f.ts"), roots());
    seed.setBv(jobId, "BV1old");
    seed.close();
    downgradeToV5(env.dbPath);

    const upgraded = env.open();
    expect(Number(rawRow(env.dbPath, "PRAGMA user_version").user_version)).toBe(SCHEMA_VERSION);
    expect(upgraded.get(jobId)).toMatchObject({ bv: "BV1old", targetState: null });
  });

  it("a failed migration warns once and keeps the legacy columns writable", () => {
    const seed = env.open();
    const { jobId } = seed.enqueue(env.job("g.ts"), roots());
    seed.close();
    downgradeToV5(env.dbPath);

    const logs: string[] = [];
    const s = new ProcQueueStore(env.dbPath, {
      now: env.now,
      log: (m) => logs.push(m),
      migrate: () => { throw new Error("disk full"); },
    });
    try {
      expect(logs.join("\n")).toContain("targetState 迁移失败");
      expect(s.setBv(jobId, "BV1legacy")).toBe(true);
      expect(s.get(jobId)).toMatchObject({ bv: "BV1legacy", targetState: null });
      expect(rawRow(env.dbPath, "SELECT bv FROM proc_jobs WHERE jobId=?", jobId).bv).toBe("BV1legacy");
    } finally {
      s.close();
    }
  });

  it("rollback: a checkpoint written by the new bundle is visible to the old columns", () => {
    const s = env.open();
    const { jobId } = s.enqueue(env.job("h.ts"), roots());
    s.setTargetState(jobId, { targetId: "bilibili", archiveId: "BV1rb", parts: 3, season: "done" });
    const row = rawRow(env.dbPath, "SELECT bv, seasonState FROM proc_jobs WHERE jobId=?", jobId);
    expect(row).toMatchObject({ bv: "BV1rb", seasonState: "done" });
  });
});
