/**
 * db-merge.ts — 把**历史的兄弟库**并进控制库(issue #750)。
 *
 * 历史布局(`<root>/db/` 或显式 `--db` 的目录):
 *   - `douyin-rec.db`       → tasks / settings / merge_jobs / hub_rules / upload_limits
 *   - `douyin-rec-sync.db`  → sync_jobs / sync_candidates / sync_job_events / sync_job_steps /
 *                             sync_node_states / sync_parts / upload_limits
 *   - `room-stats.db`       → room_sessions
 *   - 自定义 `--db path/custom.db` 的兄弟库 `path/custom-sync.db` 同样识别。
 *
 * 纪律(PR #751 审查后收紧):
 *   - **整体一个事务**:拷贝 + 行数对账 + `upload_limits` 合并 + marker 全在 `BEGIN IMMEDIATE` 内;
 *     任一步失败 `ROLLBACK`,下次启动会重新迁(不会「迁了一半就永久跳过」)。
 *   - marker 在事务内**重新检查**,并发首开的另一个进程会看到已完成并直接跳过。
 *   - 表结构照抄源库 `sqlite_master`(老列不丢);目标表已存在时按**列交集**拷贝,并补两处语义映射:
 *     `tasks.recorder → tasks.engine`(老库只有 recorder 时)、`AUTOINCREMENT` 高水位(`sqlite_sequence`)。
 *   - `upload_limits`:老 schema(单行 `id=1` 无 `key`)归一化成 `key='default'`;合并时**目标和源一起**
 *     逐 key 取并集(`times` 去重、`blockedUntil`/`updatedAt` 取大),绝不因为迁移放宽已冷却的额度。
 *   - 旧库**只读、原样保留**(改名/删除会让别的连接继续写旧 inode → 旧路径像丢数据)。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MARKER = "db_merge_v1";

interface Legacy {
  main: string;
  sync: string;
  stats: string;
}

export interface MergeOutcome {
  /** 实际并入的旧库文件名。 */
  mergedFiles: string[];
  /** 每张表搬了多少行。 */
  tables: Array<{ table: string; rows: number }>;
  /** upload_limits 合并后的 key 数。 */
  uploadLimits: number;
  /** 保留在原处的旧库路径(= 回滚来源)。 */
  backups: string[];
}

export interface MergeDeps {
  db: DatabaseSync;
  /** 控制库自身的绝对路径(与某条 legacy main 相同 → 不自我 ATTACH,只迁兄弟库)。 */
  controlPath: string;
  /** 旧库候选路径(可含不存在的)。 */
  legacy: Legacy;
  log?: (m: string) => void;
}

/** 旧库候选:同目录两套命名都认(默认名 + 显式 `--db` 派生名)。 */
export function legacyCandidates(controlPath: string): Legacy {
  const dir = dirname(controlPath);
  const base = basename(controlPath).replace(/\.db$/, "");
  return {
    main: join(dir, "douyin-rec.db"),
    sync: base === "drec-control" ? join(dir, "douyin-rec-sync.db") : join(dir, `${base}-sync.db`),
    stats: join(dir, "room-stats.db"),
  };
}

/** 同目录其它可能的 sync 兄弟(默认名 + 显式名两套都试)。 */
function syncCandidates(controlPath: string): string[] {
  const dir = dirname(controlPath);
  const base = basename(controlPath).replace(/\.db$/, "");
  return [join(dir, `${base}-sync.db`), join(dir, "douyin-rec-sync.db")].filter((p, i, a) => a.indexOf(p) === i);
}

function tableExists(db: DatabaseSync, name: string, schema = "main"): boolean {
  return db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

function columnsOf(db: DatabaseSync, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

function countRows(db: DatabaseSync, schema: string, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${schema}."${table}"`).get() as { n: number }).n);
}

function copySchema(db: DatabaseSync, alias: string, table: string): void {
  const row = db.prepare(`SELECT sql FROM ${alias}.sqlite_master WHERE type='table' AND name=?`).get(table) as { sql?: string } | undefined;
  if (!row?.sql) throw new Error(`[db-merge] ${alias}.${table}: 源库没有表定义`);
  db.exec(row.sql);
  for (const i of db.prepare(`SELECT sql FROM ${alias}.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(table) as Array<{ sql: string }>) {
    try { db.exec(i.sql); } catch { /* 同名索引已存在 */ }
  }
}

/** tasks 的语义映射:`recorder`(老列)→ `engine`。返回 SELECT 用的表达式表。 */
function taskSelectExpr(sourceCols: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of sourceCols) out[c] = `"${c}"`;
  // 只有源表**没有** engine 时才从 recorder 派生(否则会覆盖掉源库已选好的引擎)。
  if (sourceCols.includes("recorder") && !sourceCols.includes("engine")) {
    out["engine"] = `CASE WHEN "recorder" LIKE '%mesio%' THEN 'mesio' ELSE 'ffmpeg' END`;
  }
  return out;
}

/** 上限表的 schema 归一化:老单行 `id=1`(无 key) → `key='default'`。 */
function limitRows(db: DatabaseSync, alias: string): Array<{ key: string; blockedUntil: number; times: string; updatedAt: number }> {
  if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='upload_limits'`).get()) return [];
  const cols = columnsOf(db, alias, "upload_limits");
  const keyExpr = cols.includes("key") ? `"key"` : `'default'`;
  return db
    .prepare(`SELECT ${keyExpr} AS key, COALESCE(blockedUntil,0) AS blockedUntil, COALESCE(times,'[]') AS times, COALESCE(updatedAt,0) AS updatedAt FROM ${alias}.upload_limits`)
    .all() as Array<{ key: string; blockedUntil: number; times: string; updatedAt: number }>;
}

function parseTimes(raw: string): number[] {
  try {
    const j = JSON.parse(raw || "[]");
    return Array.isArray(j) ? j.filter((x): x is number => typeof x === "number") : [];
  } catch { return []; }
}

/**
 * 目标库自己可能还是**老单行 schema**(`upload_limits(id=1)`,无 `key`)——显式 `--db` 复用旧主库时就会撞上。
 * 先就地重建成新 schema(单行映射到 `default`),否则后面 `SELECT key` 直接报 no such column。
 */
function normalizeTargetLimits(db: DatabaseSync): void {
  if (!tableExists(db, "upload_limits")) return;
  const cols = columnsOf(db, "main", "upload_limits");
  if (cols.includes("key")) return;
  const rows = db.prepare(`SELECT * FROM upload_limits`).all() as Array<Record<string, unknown>>;
  db.exec(`ALTER TABLE upload_limits RENAME TO upload_limits_legacy`);
  db.exec(`CREATE TABLE upload_limits(key TEXT PRIMARY KEY, blockedUntil INTEGER NOT NULL DEFAULT 0,
    times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0)`);
  const ins = db.prepare(`INSERT OR REPLACE INTO upload_limits(key, blockedUntil, times, updatedAt) VALUES (?,?,?,?)`);
  for (const r of rows) {
    ins.run("default", Number(r["blockedUntil"]) || 0, String(r["times"] ?? "[]"), Number(r["updatedAt"]) || 0);
  }
  db.exec(`DROP TABLE upload_limits_legacy`);
}

function mergeUploadLimits(db: DatabaseSync, attached: readonly string[]): number {
  normalizeTargetLimits(db);
  const rows = attached.flatMap((a) => limitRows(db, a));
  if (tableExists(db, "upload_limits")) {
    rows.push(...(db.prepare(`SELECT key, COALESCE(blockedUntil,0) AS blockedUntil, COALESCE(times,'[]') AS times, COALESCE(updatedAt,0) AS updatedAt FROM upload_limits`).all() as typeof rows));
  }
  if (rows.length === 0) return 0;
  const byKey = new Map<string, { blockedUntil: number; times: number[]; updatedAt: number }>();
  for (const r of rows) {
    const cur = byKey.get(r.key) ?? { blockedUntil: 0, times: [], updatedAt: 0 };
    byKey.set(r.key, {
      blockedUntil: Math.max(cur.blockedUntil, Number(r.blockedUntil) || 0),
      times: Array.from(new Set([...cur.times, ...parseTimes(r.times)])).sort((a, b) => a - b),
      updatedAt: Math.max(cur.updatedAt, Number(r.updatedAt) || 0),
    });
  }
  if (!tableExists(db, "upload_limits")) {
    db.exec(`CREATE TABLE upload_limits(key TEXT PRIMARY KEY, blockedUntil INTEGER NOT NULL DEFAULT 0,
      times TEXT NOT NULL DEFAULT '[]', updatedAt INTEGER NOT NULL DEFAULT 0)`);
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO upload_limits(key, blockedUntil, times, updatedAt) VALUES (?,?,?,?)`);
  for (const [key, v] of byKey) ins.run(key, v.blockedUntil, JSON.stringify(v.times), v.updatedAt);
  return byKey.size;
}

/** 拷贝 `sqlite_sequence` 高水位(否则删过的高 ID 会被重用,历史 taskId 撞车)。 */
function copyAutoincrement(db: DatabaseSync, alias: string, tables: readonly string[]): void {
  if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name='sqlite_sequence'`).get()) return;
  const src = db.prepare(`SELECT name, seq FROM ${alias}.sqlite_sequence`).all() as Array<{ name: string; seq: number }>;
  for (const row of src) {
    if (!tables.includes(row.name)) continue;
    const cur = db.prepare(`SELECT seq FROM main.sqlite_sequence WHERE name=?`).get(row.name) as { seq: number } | undefined;
    if (cur) db.prepare(`UPDATE main.sqlite_sequence SET seq=? WHERE name=?`).run(Math.max(Number(cur.seq) || 0, Number(row.seq) || 0), row.name);
    else db.prepare(`INSERT INTO main.sqlite_sequence(name, seq) VALUES (?, ?)`).run(row.name, Number(row.seq) || 0);
  }
}

const TABLE_SPECS = {
  main: ["tasks", "settings", "merge_jobs", "hub_rules"],
  sync: ["sync_jobs", "sync_candidates", "sync_job_events", "sync_job_steps", "sync_node_states", "sync_parts"],
  stats: ["room_sessions"],
} as const;

/**
 * 迁入入口:事务内拷贝 + 对账 + marker;已迁过(marker 存在)则什么都不做。
 * 任何失败抛出,由调用方决定是否阻止启动(fail-closed)。
 */
export function mergeLegacyDatabases(deps: MergeDeps): MergeOutcome | undefined {
  const { db, controlPath, log } = deps;
  const legacy = deps.legacy;
  const existing = (Object.keys(legacy) as Array<keyof Legacy>).filter((k) => existsSync(legacy[k]));
  if (existing.length === 0) return undefined;

  db.exec("BEGIN IMMEDIATE");
  const attached: string[] = [];
  try {
  // marker 在事务内复查:并发首开的另一进程若已完成,这里直接跳过。
  if (tableExists(db, "settings")) {
    const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(MARKER) as { value?: string } | undefined;
    if (row?.value) { db.exec("COMMIT"); return undefined; }
  }

  const tables: Array<{ table: string; rows: number }> = [];
  const mergedFiles: string[] = [];

  const attach = (path: string, alias: string): boolean => {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    // 控制库自己出现在候选里(显式 `--db custom.db` 复用旧主库)→ 不自我 ATTACH。
    if (path === controlPath) return false;
    db.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS ${alias}`);
    attached.push(alias);
    mergedFiles.push(basename(path));
    return true;
  };

  const copyTables = (alias: string, list: readonly string[], seqTables: readonly string[]): void => {
    for (const table of list) {
      if (!db.prepare(`SELECT 1 FROM ${alias}.sqlite_master WHERE type='table' AND name=?`).get(table)) continue;
      if (!tableExists(db, table)) copySchema(db, alias, table);
      const dstCols = columnsOf(db, "main", table);
      const srcCols = columnsOf(db, alias, table);
      const exprs = table === "tasks" ? taskSelectExpr(srcCols) : Object.fromEntries(srcCols.map((c) => [c, `"${c}"`]));
      const cols = Object.keys(exprs).filter((c) => dstCols.includes(c));
      const usable = cols;
      if (usable.length === 0) throw new Error(`[db-merge] ${table}: 源/目标无公共列`);
      const before = countRows(db, "main", table);
      db.exec(`INSERT OR IGNORE INTO main."${table}" (${usable.map((c) => `"${c}"`).join(",")}) SELECT ${usable.map((c) => exprs[c]).join(",")} FROM ${alias}."${table}"`);
      tables.push({ table, rows: countRows(db, "main", table) - before });
      const srcN = countRows(db, alias, table);
      if (countRows(db, "main", table) < srcN) throw new Error(`[db-merge] ${table} 对账失败:目标 ${countRows(db, "main", table)} < 源 ${srcN}`);
      log?.(`[db-merge] ${table}: 源 ${srcN} 行 → 目标 ${countRows(db, "main", table)} 行`);
    }
    copyAutoincrement(db, alias, seqTables);
  };

  // ① 旧主库(若就是控制库本身则跳过:行已经在那了)
  const mainAlias = "old_main";
  const mainAttached = attach(legacy.main, mainAlias);
  if (mainAttached) copyTables(mainAlias, TABLE_SPECS.main, ["tasks"]);

  // ② 台账库:默认名 + 显式 `--db` 派生名都试
  const syncPaths = [legacy.sync, ...syncCandidates(controlPath)].filter((p, i, a) => a.indexOf(p) === i);
  let syncAliasIdx = 0;
  for (const p of syncPaths) {
    const alias = `old_sync${syncAliasIdx}`;
    if (!attach(p, alias)) continue;
    syncAliasIdx += 1;
    copyTables(alias, TABLE_SPECS.sync, []);
  }

  // ③ 统计库
  if (attach(legacy.stats, "old_stats")) copyTables("old_stats", TABLE_SPECS.stats, []);

  const uploadLimits = mergeUploadLimits(db, attached);

  // ④ marker(与拷贝同一事务:失败一起回滚,不会留下「迁了一半」)
  db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)`).run(MARKER, new Date().toISOString());

  // SQLite 不允许在事务内 DETACH → 先 COMMIT 再拆(拆之前别名已不再被引用)。
  db.exec("COMMIT");
  for (const alias of attached) db.exec(`DETACH DATABASE ${alias}`);
  attached.length = 0;

  // 全部提交成功后才落日志(旧库原样保留;人工确认后可删)。
  log?.(`[db-merge] 完成:并入 ${mergedFiles.join(", ")};旧库保留在原处(核对无误后可人工删除)`);
  return { mergedFiles, tables, uploadLimits, backups: [legacy.main, legacy.sync, legacy.stats].filter((p) => existsSync(p)) };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
    // 回滚之后才允许 DETACH(事务内 DETACH 会报 database is locked)。
    for (const alias of attached) { try { db.exec(`DETACH DATABASE ${alias}`); } catch { /* 已 detach */ } }
    throw e;
  }
}

