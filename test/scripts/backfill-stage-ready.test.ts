/**
 * backfill-stage-ready.mjs(issue #188):存量台账补写 STAGE_READY 的**保守判定**。
 * 核心不变量:真事故(止步 select 的「所有节点断流」、任何碰过上传节点的行)绝不被动。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "backfill-stage-ready.mjs");

interface Row { streamKey: string; state: string; error: string | null }

function seed(dbPath: string, rows: Array<[string, (db: DatabaseSync) => void]>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY,state TEXT,winnerWorker TEXT,bv TEXT,error TEXT,fails INTEGER DEFAULT 0,updatedAt INTEGER);
CREATE TABLE sync_job_steps(streamKey TEXT,step TEXT,phase TEXT,at INTEGER,detail TEXT);
CREATE TABLE sync_node_states(streamKey TEXT,node TEXT,state TEXT,updatedAt INTEGER);`);
  const ins = db.prepare("INSERT INTO sync_jobs VALUES(?,?,?,?,?,0,?)");
  for (const [key, extra] of rows) { ins.run(key, "needs_manual", "w", null, null, 1); extra(db); }
  db.close();
}

function run(dbPath: string, apply: boolean): string {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, dbPath, ...(apply ? ["--apply"] : [])],
    { encoding: "utf-8" });
  expect(r.status).toBe(0);
  return r.stdout;
}

function errors(dbPath: string): Row[] {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT streamKey, state, error FROM sync_jobs").all() as unknown as Row[];
  db.close();
  return rows;
}

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backfill-stage-"));
  dbPath = join(dir, "x-sync.db");
});

describe("backfill-stage-ready", () => {
  it("默认只读,不写库", () => {
    seed(dbPath, [
      ["douyin:A:2026-10-01", (db) => { db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:A:2026-10-01", "merge", "done", 1, null); }],
    ]);
    const out = run(dbPath, false);
    expect(out).toContain("判为 stage 正常收口(建议补写): 1 —— 加 --apply 才写入");
    expect(errors(dbPath)[0].error).toBeNull();
  });

  it("--apply 只补写 stage 正常收口行", () => {
    seed(dbPath, [
      ["douyin:A:2026-10-01", (db) => { db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:A:2026-10-01", "merge", "done", 1, null); }],
    ]);
    run(dbPath, true);
    expect(errors(dbPath)[0].error).toContain("stage 模式正常收口");
  });

  it("绝不碰「所有节点断流」(止步 select)与碰过上传节点的行", () => {
    seed(dbPath, [
      // 全断流:没有 merge done
      ["douyin:DEAD:2026-10-01", (db) => { db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:DEAD:2026-10-01", "select", "done", 1, null); }],
      // stage 收口但曾进入上传节点 → 结果不确定,不动
      ["douyin:UPL:2026-10-01", (db) => {
        db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:UPL:2026-10-01", "merge", "done", 1, null);
        db.prepare("INSERT INTO sync_node_states VALUES(?,?,?,?)").run("douyin:UPL:2026-10-01", "upload_plain", "running", 1);
      }],
      // stage 收口但清理失败 → 人工要看,不动
      ["douyin:CLN:2026-10-01", (db) => {
        db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:CLN:2026-10-01", "merge", "done", 1, null);
        db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:CLN:2026-10-01", "clean_source", "failed", 2, null);
      }],
    ]);
    const out = run(dbPath, true);
    expect(out).toContain("判为 stage 正常收口(建议补写): 0");
    expect(out).toContain("无法判定,需人工看: 3");
    expect(errors(dbPath).every((r) => r.error === null)).toBe(true);
  });

  it("空字符串 error 也算空(与空 error 同等处理)", () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY,state TEXT,winnerWorker TEXT,bv TEXT,error TEXT,fails INTEGER DEFAULT 0,updatedAt INTEGER);
CREATE TABLE sync_job_steps(streamKey TEXT,step TEXT,phase TEXT,at INTEGER,detail TEXT);
CREATE TABLE sync_node_states(streamKey TEXT,node TEXT,state TEXT,updatedAt INTEGER);`);
    db.prepare("INSERT INTO sync_jobs VALUES(?,?,?,?,?,0,?)").run("douyin:W:2026-10-01", "needs_manual", "w", null, "  ", 1);
    db.prepare("INSERT INTO sync_job_steps VALUES(?,?,?,?,?)").run("douyin:W:2026-10-01", "merge", "done", 1, null);
    db.close();
    run(dbPath, true);
    expect(errors(dbPath)[0].error).toContain("stage 模式正常收口");
  });

  it("台账不存在 → 退出码 2,不抛栈", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, join(dir, "nope.db")], { encoding: "utf-8" });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain("at ");
  });
});
