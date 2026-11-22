/**
 * core/sqlite-errors.ts — 把 node:sqlite 抛出的错误归类成「能不能自愈」的几种（纯函数）。
 *
 * 为什么需要：2026-11-21 主控（issue #742）在 WAL 模式的 SQLite 上遇到
 * `disk I/O error`（SQLITE_IOERR）后，进程内**连新开连接都持续失败**，直到重启容器才恢复。
 * 这种情况下再包一层「重开重试」救不回来，只能：① 认清错误类别，② 回 503 + 写清
 * 「这不是数据坏了，是挂载/共享内存层的问题」，③ 把完整原文打进日志。
 *
 * Node 24 的 `DatabaseSync` 错误形状（实测）：`code: "ERR_SQLITE_ERROR"`、
 * `errcode: <数字主码/扩展码>`、`errstr: "disk I/O error"`、`message` 同名文案。
 * `errcode` 不保证在所有版本/路径上都存在 → 文案兜底。
 */

/** node:sqlite 错误的可读字段（其它字段忽略）。 */
export interface SqliteErrorLike {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

/** 归类：io=挂载/读写层出问题；locked=并发锁；corrupt=库损坏；other=其余（含非 SQLite 错误）。 */
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
  const text = sqliteErrorText(error);
  if (!text) return "other";
  if (/database disk image is malformed|file is not a database/i.test(text)) return "corrupt";
  if (/database (table )?is locked|database is busy/i.test(text)) return "locked";
  if (/disk I\/O error|unable to open database|attempt to write a readonly database|readonly/i.test(text)) return "io";
  return "other";
}

/**
 * 是不是「拿不到库」类的 I/O 故障（对应 HTTP 503：服务暂时不可用，但数据没坏）。
 * 与 `classifySqliteError(e) === "corrupt"` 有意区分：损坏要报损坏，不能混进 I/O。
 */
export function isSqliteIoError(error: unknown): boolean {
  return classifySqliteError(error) === "io";
}

/** IO 故障的运维提示：别重试、别翻数据、先看挂载。 */
export const SQLITE_IO_HINT =
  "这不是数据损坏：SQLite 库（WAL 模式）在绑定/共享挂载上会因 -wal/-shm 视图分叉而持续报 I/O 错误，进程内重开连接也救不回；请检查数据根所在挂载，通常需要重启主控容器";
