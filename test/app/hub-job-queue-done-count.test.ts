/**
 * hub-job-queue-done-count.test.ts — issue #742 回归：队列的 done 计数不能把「读不到」报成 0。
 *
 * 覆盖四条路径：
 *   ① 台账文件不存在 → 0（#561 的 hub 首次启动空态，不能变成故障）
 *   ② 台账存在但读失败且属 I/O → 上抛（让 /api/hub/queue 走 503，而不是「done=0」）
 *   ③ 台账存在、读失败但只是结构问题（非 I/O）→ 0（旧库缺表等仍按空态）
 *   ④ 台账存在且正常 → 真实计数
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doneCount } from "../../packages/app/src/hub-job-queue.js";

function sqliteError(errcode: number, errstr: string): Error {
  const e = new Error(errstr) as Error & { code: string; errcode: number; errstr: string };
  e.code = "ERR_SQLITE_ERROR";
  e.errcode = errcode;
  e.errstr = errstr;
  return e;
}

function sqliteIoError(): Error {
  return sqliteError(10, "disk I/O error");
}

describe("doneCount(syncDbPath, read)", () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-done-"));
  const existing = join(dir, "sync.db");
  writeFileSync(existing, "");

  it("台账文件不存在 → 0（空态，不是故障）", () => {
    expect(doneCount(join(dir, "missing.db"), () => 99)).toBe(0);
    // 父级是文件 → ENOTDIR 同样算「没有这个文件」
    expect(doneCount(join(existing, "child.db"), () => 99)).toBe(0);
  });

  it("台账存在但读失败且属 I/O → 上抛（不伪装成 done=0）", () => {
    expect(() => doneCount(existing, () => { throw sqliteIoError(); })).toThrow(/disk I\/O error/);
  });

  it("台账存在、读失败但属结构性缺失（缺表/缺列等 other）→ 0", () => {
    expect(doneCount(existing, () => { throw new TypeError("缺少必需列"); })).toBe(0);
    expect(doneCount(existing, () => { throw sqliteError(1, "no such table: sync_jobs"); })).toBe(0);
  });

  it("台账存在、读失败属 locked / corrupt → 上抛（同样不能装作 done=0）", () => {
    expect(() => doneCount(existing, () => { throw sqliteError(5, "database is locked"); })).toThrow(/locked/);
    expect(() => doneCount(existing, () => { throw sqliteError(11, "database disk image is malformed"); })).toThrow(/malformed/);
  });

  it("台账存在且正常 → 真实计数", () => {
    expect(doneCount(existing, () => 7)).toBe(7);
    expect(doneCount(existing, () => 0)).toBe(0);
  });
});
