/**
 * app/db.ts — open a node:sqlite (Node 24 builtin) database and run idempotent migration.
 *
 * Node 24.15: `node:sqlite` works WITHOUT any runtime flag. It emits an
 * ExperimentalWarning on first import — harmless, and does NOT affect the
 * stateless record/merge/burn/upload commands (they never import this module).
 *
 * DB path resolution: explicit arg > env DOUYIN_REC_DB > <DOUYIN_REC_ROOT ?? DEFAULT_ROOT>/db/douyin-rec.db.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { rootDbPath } from "./paths.js";

/** Resolve the db path: explicit arg > env DOUYIN_REC_DB > <root>/db/douyin-rec.db (root always resolves, see paths.ts). */
export function resolveDbPath(path?: string): string {
  return path ?? process.env.DOUYIN_REC_DB ?? rootDbPath();
}

/**
 * Open the database at `path` (resolved via resolveDbPath) and run migration.
 * Migration uses CREATE TABLE IF NOT EXISTS + idempotent ALTER so it is safe to
 * call repeatedly on both fresh and pre-existing databases.
 */
export function openDb(path?: string): DatabaseSync {
  const p = resolveDbPath(path);
  // node:sqlite 不会创建父目录;root 模式下 <root>/db/ 可能不存在 → 先建。:memory: 跳过。
  if (p !== ":memory:") {
    const dir = dirname(p);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(p);
  migrate(db);
  return db;
}

/** Idempotent schema creation + column backfill. Safe to run on every open. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      room         TEXT NOT NULL,
      platform     TEXT NOT NULL DEFAULT 'douyin',
      name         TEXT,
      quality      TEXT DEFAULT 'origin',
      engine       TEXT NOT NULL DEFAULT 'ffmpeg',
      danmu        INTEGER DEFAULT 1,
      segmentSec   INTEGER DEFAULT 1800,
      cookies      TEXT,
      outDir       TEXT,
      scheduleStart TEXT,
      scheduleEnd  TEXT,
      status       TEXT DEFAULT 'stopped',
      useCookie    INTEGER NOT NULL DEFAULT 1,
      enabled      INTEGER NOT NULL DEFAULT 0,
      createdAt    TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS merge_jobs (
      id        TEXT PRIMARY KEY,
      taskId    INTEGER NOT NULL,
      state     TEXT NOT NULL DEFAULT 'running',
      sessions  TEXT,
      mp4       TEXT,
      xml       TEXT,
      error     TEXT,
      createdAt TEXT
    );
  `);
  // 注:多节点 hub 规则**不在 DB**——已迁到文件 <root>/config/hub/{roomSlug}.json(见 hub-store.ts)。
  // 旧库若有遗留 hub_rules 表,留着无害(不再读写)。

  // `CREATE TABLE IF NOT EXISTS` never alters an EXISTING table, so columns
  // added after a db was first created must be backfilled here. Each entry is
  // an idempotent ALTER guarded by a PRAGMA check; existing rows take the
  // column DEFAULT. Mirror this pattern for any future column additions.
  // 平台 id（A1 Platform 抽象）：旧库无此列 → 回填 'douyin'（迁移前只有抖音）。
  ensureColumn(db, "tasks", "platform", "TEXT NOT NULL DEFAULT 'douyin'");
  ensureColumn(db, "tasks", "useCookie", "INTEGER NOT NULL DEFAULT 1");
  // 用户意图开关：0=停用(daemon 永不启动)，1=启用(按 schedule 管理)。旧库默认停用。
  ensureColumn(db, "tasks", "enabled", "INTEGER NOT NULL DEFAULT 0");
  // engine 列（plan 031 Part A 引擎策略化）：录制器去重为「通用录制器 + ffmpeg/mesio 引擎」。
  //   新库由 CREATE TABLE 的 DEFAULT 'ffmpeg' 兜底;旧库 ensureColumn 补列(现有行取 DEFAULT),
  //   再按旧 `recorder` 值幂等回填:*-mesio-recorder → mesio,其余(含 dlr)→ ffmpeg。
  //   仅当旧库仍有 `recorder` 列时才回填(新库已无此列)。
  ensureColumn(db, "tasks", "engine", "TEXT NOT NULL DEFAULT 'ffmpeg'");
  if (hasColumn(db, "tasks", "recorder")) {
    db.exec(`UPDATE tasks SET engine='mesio' WHERE recorder LIKE '%-mesio-recorder'`);
    db.exec(
      `UPDATE tasks SET engine='ffmpeg' WHERE recorder IN ('douyin-live-recorder','bilibili-live-recorder','dlr','bililive')`,
    );
  }
  // `recorder` / `danmuProvider` 列：**已废弃并删除**(plan 031 Part A/B —— 录制器策略化为
  //   engine，弹幕收进 Platform.connectDanmu，二者代码均不再读写)。engine 回填后即可丢弃。
  //   幂等 DROP COLUMN(node:sqlite on Node 24 支持);新库 CREATE TABLE 已无此二列。
  dropColumn(db, "tasks", "recorder");
  dropColumn(db, "tasks", "danmuProvider");
  // 自动抓取的主播名（创建任务时 getInfo().owner；录制时 `[主播]` 日志刷新）。可空。
  // 显示优先级：name > anchorName > room。
  ensureColumn(db, "tasks", "anchorName", "TEXT");
  // 任务专属 Discord webhook（开播/录完/合并完成/错误事件）。null = 回落全局 settings.discordWebhook。
  ensureColumn(db, "tasks", "webhook", "TEXT");
  // 注:多节点 hub 配置已独立成 hub_rules 表(按 roomSlug),不再放 tasks 上。
}

/**
 * Add `column` (with the given SQL type/constraints) to `table` if it is not
 * already present. No-op when the column exists, so it is safe to re-run.
 */
function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  typeDef: string,
): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
}

/** True if `column` currently exists on `table`. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

/**
 * Drop `column` from `table` if present. No-op when absent, so it is safe to
 * re-run. node:sqlite on Node 24 supports `ALTER TABLE ... DROP COLUMN`.
 */
function dropColumn(db: DatabaseSync, table: string, column: string): void {
  if (!hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
