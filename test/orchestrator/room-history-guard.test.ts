import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HUB_TABLE_NAMES, jobLogPathCandidates } from "@drec/core";
import { activeHubJobKeys } from "../../packages/app/src/hub-jobs.js";
import { deleteHubHistory } from "../../packages/orchestrator/src/ledger-history.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledger(state?: string | null): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "room-history-guard-"));
  roots.push(root);
  const dbPath = join(root, "sync.db");
  const db = new DatabaseSync(dbPath);
  for (const table of HUB_TABLE_NAMES) {
    db.exec(`CREATE TABLE ${table} (streamKey TEXT PRIMARY KEY, state TEXT, updatedAt INTEGER)`);
  }
  if (state !== undefined) {
    db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, ?, 1)")
      .run("douyin:123:session", state);
  }
  db.close();
  return { root, dbPath };
}

function seedRelatedHistory(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  for (const table of HUB_TABLE_NAMES) {
    if (table === "sync_jobs") continue;
    db.prepare(`INSERT INTO ${table}(streamKey, state, updatedAt) VALUES(?, ?, 1)`)
      .run("douyin:123:session", "merging");
  }
  db.close();
}

function jobLog(root: string, streamKey = "douyin:123:session"): string {
  const candidates = jobLogPathCandidates(root, streamKey, root);
  const path = candidates[0];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "keep");
  return path;
}

describe("active room history guard", () => {
  it("allows only a missing database or a proven legacy database without sync_jobs", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "room-history-missing-")), "none.db");
    roots.push(dirname(missing));
    expect(activeHubJobKeys(missing, "douyin.123")).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), "room-history-legacy-"));
    roots.push(root);
    const db = new DatabaseSync(join(root, "legacy.db"));
    db.close();
    expect(activeHubJobKeys(join(root, "legacy.db"), "douyin.123")).toEqual([]);
  });

  it("does not turn an unreadable or malformed active query into idle", () => {
    const { root, dbPath } = ledger();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE sync_jobs; CREATE TABLE sync_jobs (wrongKey TEXT, state TEXT)");
    db.close();
    const logPath = jobLog(root);
    expect(() => activeHubJobKeys(dbPath, "douyin.123")).toThrow();
    expect(() => deleteHubHistory({ syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root }))
      .toThrow();
    expect(existsSync(logPath)).toBe(true);
  });

  it("allows terminal jobs without being blocked by active sibling rooms", () => {
    const { root, dbPath } = ledger();
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, ?, 2)");
    for (const state of ["done", "failed", "needs_manual"]) insert.run(`douyin:123:${state}`, state);
    insert.run("douyin:1234:session", "merging");
    insert.run("douyin:abXcd:session", "merging");
    db.close();
    expect(activeHubJobKeys(dbPath, "douyin.123")).toEqual([]);
    expect(activeHubJobKeys(dbPath, "douyin.ab%cd")).toEqual([]);
    const result = deleteHubHistory({ syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root });
    expect(result.deleted).toBe(3);
    expect(result.streamKeys.sort()).toEqual(["douyin:123:done", "douyin:123:failed", "douyin:123:needs_manual"]);
    expect(activeHubJobKeys(dbPath, "douyin.1234")).toEqual(["douyin:1234:session"]);
  });

  it("treats a case-variant sync_jobs table as the ledger and refuses active rows", () => {
    const { root, dbPath } = ledger();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE sync_jobs; CREATE TABLE SYNC_JOBS (streamKey TEXT PRIMARY KEY, state TEXT, updatedAt INTEGER)");
    db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, 'merging', 2)")
      .run("douyin:123:case-variant");
    db.close();
    expect(activeHubJobKeys(dbPath, "douyin.123")).toEqual(["douyin:123:case-variant"]);
    expect(() => deleteHubHistory({ syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root }))
      .toThrow(/active or unknown/);
    const after = new DatabaseSync(dbPath);
    expect(after.prepare("SELECT state FROM sync_jobs WHERE streamKey = ?").get("douyin:123:case-variant"))
      .toMatchObject({ state: "merging" });
    after.close();
  });

  it("rejects a sync_jobs view instead of treating it as a legacy database", () => {
    const { root, dbPath } = ledger();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE sync_jobs; CREATE VIEW sync_jobs AS SELECT 'douyin:123:x' AS streamKey, 'done' AS state, 1 AS updatedAt");
    seedRelatedHistory(dbPath);
    const logPath = jobLog(root);
    expect(() => activeHubJobKeys(dbPath, "douyin.123")).toThrow(/Unexpected schema object type/);
    expect(() => deleteHubHistory({ syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root }))
      .toThrow(/Unexpected schema object type/);
    expect(existsSync(logPath)).toBe(true);
    const after = new DatabaseSync(dbPath);
    for (const table of HUB_TABLE_NAMES) {
      if (table === "sync_jobs") continue;
      expect(after.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE streamKey = ?`).get("douyin:123:session"))
        .toMatchObject({ count: 1 });
    }
    after.close();
  });

  it("sees an active row committed while the writer waits for its lock", async () => {
    const { root, dbPath } = ledger("done");
    const logPath = jobLog(root);
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.dbPath);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, ?, ?)")
        .run(workerData.streamKey, "merging", 2);
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        parentPort.postMessage("committed");
        db.close();
      }, 250);
    `, { eval: true, workerData: { dbPath, streamKey: "douyin:123:late" } });
    try {
      await once(worker, "message");
      const committed = once(worker, "message");
      expect(() => deleteHubHistory({ syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root }))
        .toThrow(/active or unknown/);
      await committed;
    } finally {
      await worker.terminate();
    }
    const db = new DatabaseSync(dbPath);
    expect(db.prepare("SELECT state FROM sync_jobs WHERE streamKey = ?").get("douyin:123:session"))
      .toMatchObject({ state: "done" });
    expect(db.prepare("SELECT state FROM sync_jobs WHERE streamKey = ?").get("douyin:123:late"))
      .toMatchObject({ state: "merging" });
    db.close();
    expect(existsSync(logPath)).toBe(true);
  });

  it.each(["merging", null, "future-state"])("refuses deletion and preserves ledger/logs for state %s", (state) => {
    const { root, dbPath } = ledger(state);
    seedRelatedHistory(dbPath);
    const logPath = jobLog(root);
    expect(activeHubJobKeys(dbPath, "douyin.123")).toEqual(["douyin:123:session"]);
    const options = { syncDbPath: dbPath, roomKey: "douyin.123", stageDir: root, logsDir: root };
    expect(() => deleteHubHistory(options)).toThrow();
    const db = new DatabaseSync(dbPath);
    expect(db.prepare("SELECT state FROM sync_jobs WHERE streamKey = ?").get("douyin:123:session"))
      .toMatchObject({ state });
    for (const table of HUB_TABLE_NAMES) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE streamKey = ?`).get("douyin:123:session"))
        .toMatchObject({ count: 1 });
    }
    db.close();
    expect(existsSync(logPath)).toBe(true);
  });

});
