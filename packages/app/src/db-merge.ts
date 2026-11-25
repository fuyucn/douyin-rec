/**
 * db-merge.ts — 一次性把**历史的 3 个兄弟库**并进同一个控制库(issue #750)。
 *
 * 迁入的旧库(全部位于 `<root>/db/`):
 *   - `douyin-rec.db`   → tasks / settings / merge_jobs / hub_rules / upload_limits
 *   - `douyin-rec-sync.db` → sync_jobs / sync_candidates / sync_job_events / sync_job_steps /
 *                            sync_node_states / sync_parts / upload_limits
 *   - `room-stats.db`   → room_sessions
 *
 * 纪律:
 *   - **表结构从源库照抄**(`sqlite_master` 里的原始 DDL),因此旧库里的历史列/索引不会在迁移中丢;
 *     目标表已存在时按**列交集**拷贝,兼容 app 侧 migrate 先建表的情况。
 *   - **按主键 INSERT OR IGNORE**,可重复执行;行数少于源库即中止(不静默)。
 *   - `upload_limits` 两表语义相同(滚动窗口):**逐 key 取并集**(times 去重、blockedUntil 取大、updatedAt 取大),
 *     不做静默覆盖。
 *   - 全部校验通过后只写 marker,**旧库原样保留**(不改名、不删除 —— 有别的连接正打开它们时,
 *     改名/删除会让后续写入落到旧 inode、旧路径看起来像数据丢失)。
 *   - 任何一步异常都抛给调用方(fail-closed),不留下「看起来迁完其实没迁」的状态。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";

/** 每个旧库要迁的表(顺序无关;主键冲突由 INSERT OR IGNORE 吸收)。 */
const SOURCES: ReadonlyArray<{ file: "main" | "sync" | "stats"; alias: string; tables: readonly string[] }> = [
  { file: "main", alias: "old_main", tables: ["tasks", "settings", "merge_jobs", "hub_rules"] },
  { file: "sync", alias: "old_sync", tables: ["sync_jobs", "sync_candidates", "sync_job_events", "sync_job_steps", "sync_node_states", "sync_parts"] },
  { file: "stats", alias: "old_stats", tables: ["room_sessions"] },
];

export interface MergeOutcome {
  /** 已并入控制库的旧库文件名(迁移后已改名)。 */
  mergedFiles: string[];
  /** 实际搬运行的表与行数。 */
  tables: Array<{ table: string; rows: number }>;
  /** upload_limits 合并后的 key 数(0 = 两边都没有数据)。 */
  uploadLimits: number;
  /** 仍然留在原处的旧库路径(= 回滚来源;迁移只读它们,不改名不删除)。 */
  backups: string[];
}

export interface MergeDeps {
  /** 控制库已打开的连接(与调用方共用;不在此关闭)。 */
  db: DatabaseSync;
  /** 旧库三兄弟的绝对路径。 */
  legacy: { main: string; sync: string; stats: string };
  log?: (m: string) => void;
}

const MARKER = "db_merge_v1";

function tableExists(db: DatabaseSync, name: string, schema = "main"): boolean {
  const row = db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(name);
  return row !== undefined;
}

function createTableFrom(db: DatabaseSync, alias: string, table: string): boolean {
  const row = db.prepare(`SELECT sql FROM ${alias}.sqlite_master WHERE type='table' AND name=?`).get(table) as
    | { sql?: string }
    | undefined;
  if (!row?.sql) return false;
  db.exec(row.sql);
  // 索引照抄(名字可能已存在 → 忽略;索引不是数据,缺了不影响正确性,只影响查询性能)。
  const idx = db.prepare(`SELECT sql FROM ${alias}.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(table) as
    Array<{ sql: string }>;
  for (const i of idx) {
    try { db.exec(i.sql); } catch { /* 已存在同名索引 */ }
  }
  return true;
}

function columnsOf(db: DatabaseSync, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function countRows(db: DatabaseSync, schema: string, table: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${schema}."${table}"`).get() as { n: number };
  return Number(r.n);
}

/** 把 `upload_limits` 两表并成一张(同 key 取并集,不静默覆盖)。 */
function mergeUploadLimits(db: DatabaseSync, deps: MergeDeps): number {
  const rows: Array<{ key: string; blockedUntil: number; times: string; updatedAt: number }> = [];
  for (const { alias, src } of [
    { alias: "old_main", src: deps.legacy.main },
    { alias: "old_sync", src: deps.legacy.sync },
  ]) {
    if (!existsSync(src)) continue;
    const has = db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='upload_limits'`).get();
    if (!has) continue;
    rows.push(...(db.prepare(`SELECT key, blockedUntil, times, updatedAt FROM ${alias}.upload_limits`).all() as typeof rows));
  }
  if (rows.length === 0) return 0;
  const byKey = new Map<string, { blockedUntil: number; times: number[]; updatedAt: number }>();
  for (const r of rows) {
    const cur = byKey.get(r.key) ?? { blockedUntil: 0, times: [], updatedAt: 0 };
    let parsed: number[] = [];
    try { const j = JSON.parse(r.times || "[]"); if (Array.isArray(j)) parsed = j.filter((x) => typeof x === "number"); } catch { parsed = []; }
    const times = Array.from(new Set([...cur.times, ...parsed])).sort((a, b) => a - b);
    byKey.set(r.key, {
      blockedUntil: Math.max(cur.blockedUntil, Number(r.blockedUntil) || 0),
      times,
      updatedAt: Math.max(cur.updatedAt, Number(r.updatedAt) || 0),
    });
  }
  if (!tableExists(db, "upload_limits")) {
    // 两边都没有表定义(理论上不会发生) → 用与历史一致的最小 DDL。
    db.exec(`CREATE TABLE IF NOT EXISTS upload_limits(
      key TEXT PRIMARY KEY,
      blockedUntil INTEGER NOT NULL DEFAULT 0,
      times TEXT NOT NULL DEFAULT '[]',
      updatedAt INTEGER NOT NULL DEFAULT 0)`);
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO upload_limits(key, blockedUntil, times, updatedAt) VALUES (?,?,?,?)`);
  for (const [key, v] of byKey) ins.run(key, v.blockedUntil, JSON.stringify(v.times), v.updatedAt);
  deps.log?.(`[db-merge] upload_limits: ${rows.length} 行 → ${byKey.size} 个 key(逐 key 取并集)`);
  return byKey.size;
}

function hasAnyData(db: DatabaseSync): boolean {
  for (const t of ["tasks", "settings", "sync_jobs", "room_sessions"]) {
    if (!tableExists(db, t)) continue;
    if (countRows(db, "main", t) > 0) return true;
  }
  return false;
}

/**
 * 迁移入口:控制库为空(或只有 app 的空表)且旧库存在时执行;否则原样返回。
 * **可重复调用**:已迁移过(有 marker 或控制库已有数据)直接跳过。
 */
export function mergeLegacyDatabases(deps: MergeDeps): MergeOutcome | undefined {
  const { db, legacy, log } = deps;
  const present = (Object.keys(legacy) as Array<keyof typeof legacy>).filter((k) => existsSync(legacy[k]));
  if (present.length === 0) return undefined;

  // 已迁移过 → 跳过(marker 或控制库已有业务数据都算)。
  if (tableExists(db, "settings")) {
    const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(MARKER) as { value?: string } | undefined;
    if (row?.value) return undefined;
  }
  if (hasAnyData(db)) {
    log?.("[db-merge] 控制库已有数据,跳过历史迁移(只保留现有内容)");
    return undefined;
  }

  const tables: Array<{ table: string; rows: number }> = [];
  const attached: string[] = [];
  try {
    for (const src of SOURCES) {
      const file = legacy[src.file];
      if (!existsSync(file)) continue;
      if (!attached.includes(src.alias)) {
        db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS ${src.alias}`);
        attached.push(src.alias);
      }
      for (const table of src.tables) {
        const exists = db.prepare(`SELECT 1 FROM ${src.alias}.sqlite_master WHERE type='table' AND name=?`).get(table);
        if (!exists) continue;
        if (!tableExists(db, table)) createTableFrom(db, src.alias, table);
        const srcCols = columnsOf(db, src.alias, table);
        const dstCols = columnsOf(db, "main", table);
        const cols = srcCols.filter((c) => dstCols.includes(c));
        if (cols.length === 0) throw new Error(`[db-merge] ${table}: 源/目标无公共列,不迁移`);
        const list = cols.map((c) => `"${c}"`).join(",");
        const before = countRows(db, "main", table);
        db.exec(`INSERT OR IGNORE INTO main."${table}" (${list}) SELECT ${list} FROM ${src.alias}."${table}"`);
        const after = countRows(db, "main", table);
        tables.push({ table, rows: after - before });
        log?.(`[db-merge] ${table}: 源 ${countRows(db, src.alias, table)} 行 → 目标 ${after} 行(+${after - before})`);
      }
    }

    const uploadLimits = mergeUploadLimits(db, deps);

    // 行数对账:目标不得少于源(缺行 = 静默丢数据,直接中止)。
    for (const src of SOURCES) {
      if (!attached.includes(src.alias)) continue;
      for (const table of src.tables) {
        const has = db.prepare(`SELECT 1 FROM ${src.alias}.sqlite_master WHERE type='table' AND name=?`).get(table);
        if (!has || !tableExists(db, table)) continue;
        const srcN = countRows(db, src.alias, table);
        // 目标可能本来就有行(重跑),只要求「不少于源」。
        if (countRows(db, "main", table) < srcN) {
          throw new Error(`[db-merge] ${table} 对账失败:目标行数少于源(${srcN})`);
        }
      }
    }

    for (const alias of attached) db.exec(`DETACH DATABASE ${alias}`);
    attached.length = 0;

    db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)`).run(MARKER, new Date().toISOString());

    // 全部校验通过后才落 marker;**旧库原样留在磁盘上**(改名/删除都是「文件正被别的连接打开」时的
    // 隐患:写会落到改名后的 inode,旧路径看起来像丢了数据)。人工确认后可自行删除。
    const mergedFiles: string[] = [];
    for (const src of SOURCES) {
      const file = legacy[src.file];
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      mergedFiles.push(basename(file));
    }
    log?.(`[db-merge] 完成:已并入 ${mergedFiles.join(", ")};旧库保留在原处(核对无误后可人工删除)`);
    return { mergedFiles, tables, uploadLimits, backups: mergedFiles.map((f) => legacy[(Object.keys(legacy) as Array<keyof typeof legacy>).find((k) => basename(legacy[k]) === f) ?? "main"]) };
  } finally {
    for (const alias of attached) {
      try { db.exec(`DETACH DATABASE ${alias}`); } catch { /* 已 detach */ }
    }
  }
}
