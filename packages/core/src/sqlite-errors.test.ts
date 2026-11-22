/**
 * sqlite-errors.test.ts — 错误归类的形状钉死用例。
 *
 * 背景（issue #742）：主控在 bind mount 上的 WAL 库遇到 `SQLITE_IOERR` 后无法自愈，
 * 值班需要一眼分清「库拿不到（503）」与「库坏了（500 损坏）」「被锁（500 锁定）」。
 * 这里把 Node 24 `node:sqlite` 实测的错误形状（`code/errcode/errstr`）钉死，
 * 防止以后换 Node 版本或改判定时把 IO 故障误判成别的东西、或反过来把约束错误误判成 IO。
 */
import { describe, it, expect } from "vitest";
import { classifySqliteError, isSqliteIoError, sqliteBaseCode, sqliteErrorText } from "./sqlite-errors.js";

/** Node 24 `node:sqlite` 抛出的真实形状：code + errcode + errstr（message 同名）。 */
function sqliteError(errcode: number, errstr: string): Error {
  const e = new Error(errstr) as Error & { code: string; errcode: number; errstr: string };
  e.code = "ERR_SQLITE_ERROR";
  e.errcode = errcode;
  e.errstr = errstr;
  return e;
}

describe("sqliteBaseCode", () => {
  it("取主码（扩展码取低 8 位）", () => {
    expect(sqliteBaseCode(sqliteError(10, "disk I/O error"))).toBe(10);
    // SQLITE_IOERR_READ = 10 | (1<<8) = 266；SQLITE_IOERR_FSYNC = 1034
    expect(sqliteBaseCode(sqliteError(266, "disk I/O error"))).toBe(10);
    expect(sqliteBaseCode(sqliteError(1034, "disk I/O error"))).toBe(10);
  });

  it("没有 errcode 时返回 undefined（不瞎猜）", () => {
    expect(sqliteBaseCode(new Error("disk I/O error"))).toBeUndefined();
    expect(sqliteBaseCode({ errcode: "10" })).toBeUndefined();
    expect(sqliteBaseCode(null)).toBeUndefined();
  });
});

describe("sqliteErrorText", () => {
  it("errstr 优先，其次 message", () => {
    expect(sqliteErrorText(sqliteError(10, "disk I/O error"))).toBe("disk I/O error");
    expect(sqliteErrorText({ message: "disk I/O error" })).toBe("disk I/O error");
    expect(sqliteErrorText({ errstr: "server died", message: "boom" })).toBe("server died");
    expect(sqliteErrorText(new Error("x"))).toBe("x");
    expect(sqliteErrorText(undefined)).toBe("");
  });
});

describe("classifySqliteError", () => {
  it("IO 类：IOERR（含扩展码）/ CANTOPEN / READONLY", () => {
    expect(classifySqliteError(sqliteError(10, "disk I/O error"))).toBe("io");
    expect(classifySqliteError(sqliteError(266, "disk I/O error"))).toBe("io");
    expect(classifySqliteError(sqliteError(14, "unable to open database file"))).toBe("io");
    expect(classifySqliteError(sqliteError(8, "attempt to write a readonly database"))).toBe("io");
  });

  it("锁类 / 损坏类分开（都不该回 503-IO）", () => {
    expect(classifySqliteError(sqliteError(5, "database is locked"))).toBe("locked");
    expect(classifySqliteError(sqliteError(6, "database table is locked"))).toBe("locked");
    expect(classifySqliteError(sqliteError(11, "database disk image is malformed"))).toBe("corrupt");
    expect(classifySqliteError(sqliteError(26, "file is not a database"))).toBe("corrupt");
  });

  it("其它 SQLite 错误（约束/语法等）不算 IO", () => {
    expect(classifySqliteError(sqliteError(19, "constraint failed"))).toBe("other");
    expect(classifySqliteError(sqliteError(1, "SQL logic error"))).toBe("other");
    expect(classifySqliteError(new TypeError("x is not a function"))).toBe("other");
    expect(classifySqliteError(undefined)).toBe("other");
  });

  it("只有文案时按原文归类（某些路径没有 errcode）", () => {
    expect(classifySqliteError(new Error("disk I/O error"))).toBe("io");
    expect(classifySqliteError(new Error("unable to open database file"))).toBe("io");
    expect(classifySqliteError(new Error("database is locked"))).toBe("locked");
    expect(classifySqliteError(new Error("database disk image is malformed"))).toBe("corrupt");
    expect(classifySqliteError(new Error("别的问题"))).toBe("other");
  });

  it("isSqliteIoError 只认 IO（corrupt/locked 必须是 false）", () => {
    expect(isSqliteIoError(sqliteError(10, "disk I/O error"))).toBe(true);
    expect(isSqliteIoError(sqliteError(14, "unable to open database file"))).toBe(true);
    expect(isSqliteIoError(sqliteError(11, "database disk image is malformed"))).toBe(false);
    expect(isSqliteIoError(sqliteError(5, "database is locked"))).toBe(false);
    expect(isSqliteIoError(new Error("普通错误"))).toBe(false);
  });
});
