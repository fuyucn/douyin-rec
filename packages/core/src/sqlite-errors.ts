/**
 * core/sqlite-errors.ts — 把 node:sqlite 抛出的错误归类成「能不能自愈」的几种（纯函数）。
 *
 * 为什么需要：2026-11-21 主控（issue #742）在 WAL 模式的 SQLite 上遇到
 * `disk I/O error`（SQLITE_IOERR）后，进程内**连新开连接都持续失败**，直到重启容器才恢复。
 * 这种情况下再包一层「重开重试」救不回来，只能：① 认清错误类别，② 回 503 + 写清
 * 「这不是数据坏了，是挂载/共享内存层的问题」，③ 把完整原文打进日志。
 *
 * 库路径存在性判定也放这里，保证全仓只有一份口径。
 *
 * Node 24 的 `DatabaseSync` 错误形状（实测）：`code: "ERR_SQLITE_ERROR"`、
 * `errcode: <数字主码/扩展码>`、`errstr: "disk I/O error"`、`message` 同名文案。
 * `errcode` 不保证在所有版本/路径上都存在 → 文案兜底。
 */

import { statSync } from "node:fs";

/** node:sqlite / fs 错误的可读字段（其它字段忽略）。 */
export interface SqliteErrorLike {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

/** 归类：io=挂载/权限/读写层出问题；locked=并发锁；corrupt=库损坏；other=其余（含非 SQLite 错误）。 */
export type SqliteFailure = "io" | "locked" | "corrupt" | "other";

/** SQLite 主错误码（扩展码取其低 8 位主码）。 */
const BASE = {
  readonly: 8,
  ioerr: 10,
  corrupt: 11,
  cantOpen: 14,
  notADb: 26,
  busy: 5,
  locked: 6,
} as const;

function pickString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 取 SQLite 错误主码（扩展码 → 主码）；没有 `errcode` 时返回 undefined。 */
export function sqliteBaseCode(error: unknown): number | undefined {
  const errcode = pickNumber((error as SqliteErrorLike | null)?.errcode);
  return errcode === undefined ? undefined : errcode & 0xff;
}

/** 错误原文（`errstr` 优先，其次 `message`），用于日志与兜底匹配。 */
export function sqliteErrorText(error: unknown): string {
  const e = error as SqliteErrorLike | null;
  return pickString(e?.errstr) || pickString(e?.message);
}

/**
 * 归类一个错误。判据顺序：`errcode` 主码 → 文案兜底。
 * 注意 IO 类把 `READONLY`/`CANTOPEN` 也算进来（与 `readOnly` 连接碰上需要恢复的 WAL 同源，
 * 现场看就是「打不开/读不了」，不是数据损坏）。
 */
export function classifySqliteError(error: unknown): SqliteFailure {
  const base = sqliteBaseCode(error);
  if (base !== undefined) {
    if (base === BASE.corrupt || base === BASE.notADb) return "corrupt";
    if (base === BASE.busy || base === BASE.locked) return "locked";
    if (base === BASE.ioerr || base === BASE.readonly || base === BASE.cantOpen) return "io";
    return "other";
  }
  // 文件系统层的错误（权限 / 只读挂载 / 磁盘故障）：同样是「库拿不到」，要回 503 + 挂载提示，
  // 不能让 stat/open 失败落成「数据库查询失败」500（#742 review 第二轮 P2-3）。
  const fsCode = pickString((error as { code?: unknown } | null)?.code);
  if (/^(EACCES|EPERM|EROFS|EIO|ENOSPC|EDQUOT|ESTALE)$/.test(fsCode)) return "io";
  const text = sqliteErrorText(error);
  if (!text) return "other";
  if (/database disk image is malformed|file is not a database/i.test(text)) return "corrupt";
  if (/database (table )?is locked|database is busy/i.test(text)) return "locked";
  if (/disk I\/O error|unable to open database|attempt to write a readonly database|read-only file system/i.test(text)) return "io";
  return "other";
}

/**
 * 是不是「拿不到库」类的 I/O 故障（对应 HTTP 503：服务暂时不可用，但数据没坏）。
 * 与 `classifySqliteError(e) === "corrupt"` 有意区分：损坏要报损坏，不能混进 I/O。
 */
export function isSqliteIoError(error: unknown): boolean {
  return classifySqliteError(error) === "io";
}

/**
 * 库文件「确实不存在」的唯一判定（ENOENT/ENOTDIR）；其它 stat 失败一律上抛，
 * 不能当成「文件不在」——否则权限/挂载故障会被伪装成空数据（#742 review 第二轮 P2-2）。
 */
export function dbPathMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
}

/** IO 故障的运维提示：别重试、别翻数据、先看挂载（READONLY/CANTOPEN 先查权限与路径）。 */
export const SQLITE_IO_HINT =
  "这不是数据损坏：SQLite 库（WAL 模式）在绑定/共享挂载上会因 -wal/-shm 视图分叉而持续报 I/O 错误，进程内重开连接也救不回；请检查数据根所在挂载，通常需要重启主控容器（若错误码是 8/14，先查只读挂载、文件权限与库路径）";

/** 日志用标签：把「哪个错误码」写进日志，避免只剩一句 disk I/O error。 */
export function sqliteErrorTag(error: unknown): string {
  const e = error as SqliteErrorLike | null;
  const code = pickString(e?.code);
  const errcode = pickNumber(e?.errcode);
  if (!code && errcode === undefined) return "";
  const parts = [code || "ERR_SQLITE"];
  if (errcode !== undefined) parts.push(`errcode=${errcode}`);
  return `[${parts.join("/")}]`;
}
