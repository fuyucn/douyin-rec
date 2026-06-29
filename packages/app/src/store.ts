/**
 * app/store.ts — TaskStore: stateful wrapper over the node:sqlite db.
 *
 * Persists recording tasks + global settings. Mirrors (in skeleton form) the
 * Python project's RecordingTask + TaskManager / settings, but scoped down.
 * All operations are synchronous (node:sqlite is sync).
 */
import type { DatabaseSync } from "node:sqlite";
import { getPlatform, platformForRoom } from "@drec/core";
import type { TaskPipelineConfig } from "@drec/core";
import { openDb } from "./db.js";

export type TaskStatus = "stopped" | "running" | "error" | "pending" | "draining";
/** 下载引擎 id(由 Platform.engines 决定:ffmpeg / mesio;通用层用 string,不写死平台)。 */
export type EngineKind = string;
/** @deprecated 旧名(原 recorder provider id);保留为 EngineKind 别名,避免外部 import 断裂。 */
export type RecorderKind = EngineKind;

/** A persisted recording task. */
export interface Task {
  id: number;
  /** Room id or full URL. */
  room: string;
  /** 平台 id（@drec/core Platform.id，如 "douyin"）。 */
  platform: string;
  name: string | null;
  quality: string;
  /** 下载引擎 id(ffmpeg / mesio;由 Platform.engines 校验)。取代旧 `recorder` provider 字段。 */
  engine: EngineKind;
  /** 1 = capture danmu, 0 = off. 来源由命中平台的 connectDanmu 提供(不再有 provider 字段)。 */
  danmu: number;
  segmentSec: number;
  cookies: string | null;
  outDir: string | null;
  /** "HH:MM" or null. Scheduling is OUT OF SCOPE — stored only. */
  scheduleStart: string | null;
  scheduleEnd: string | null;
  status: TaskStatus;
  /**
   * Whether THIS task passes the global cookie to its recorder. true → danmu
   * via the logged-in session (gifts / more stable); false → anonymous danmu
   * (comments only). Per-task, independent of the global cookie. Default true.
   */
  useCookie: boolean;
  /**
   * User INTENT switch, orthogonal to runtime `status`. true → the scheduler
   * daemon manages this task (records within its schedule window, or 24/7 when
   * it has no window). false → the daemon never starts it, so a manual stop
   * sticks. Default false: a task must be explicitly 启动 before it runs.
   */
  enabled: boolean;
  createdAt: string;
  /** 自动抓取的主播名（创建时 getInfo().owner / 录制时刷新）；未知为 null。显示用 name>anchorName>room。 */
  anchorName: string | null;
  /**
   * 该任务专属的 Discord webhook（开播/录完/合并完成/错误事件 → 推到这里）；null = 回落全局
   * settings.discordWebhook。见 resolveTaskWebhook。
   */
  webhook: string | null;
  /** 多节点 hub pipeline 配置(per-task);null = 未配(该房间不 hub,只录)。存为 JSON。 */
  pipeline: TaskPipelineConfig | null;
}

/** Fields accepted when adding a task. Defaults applied for omitted values. */
export interface TaskInput {
  room: string;
  /** 平台 id；省略 → 按 room 判别(URL 命中 / 裸房间号回落默认平台)。 */
  platform?: string;
  name?: string | null;
  quality?: string;
  /** 下载引擎 id(ffmpeg / mesio);省略/非法 → 平台默认引擎。 */
  engine?: EngineKind;
  danmu?: number;
  segmentSec?: number;
  cookies?: string | null;
  outDir?: string | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  status?: TaskStatus;
  /** Whether this task uses the global cookie for its recorder. Default true. */
  useCookie?: boolean;
  /** User intent switch (daemon-managed). Default false. */
  enabled?: boolean;
  /** ISO string; defaults to new Date().toISOString(). */
  createdAt?: string;
  /** 任务专属 Discord webhook;null/省略 = 回落全局。 */
  webhook?: string | null;
  /** 多节点 hub pipeline 配置;省略 = 不设。 */
  pipeline?: TaskPipelineConfig | null;
}

/** Raw row shape as returned by node:sqlite (danmu/segmentSec are bigint-or-number). */
interface TaskRow {
  id: number;
  room: string;
  platform: string | null;
  name: string | null;
  quality: string;
  engine: string | null;
  danmu: number;
  segmentSec: number;
  cookies: string | null;
  outDir: string | null;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  status: string;
  useCookie: number;
  enabled: number;
  createdAt: string;
  anchorName: string | null;
  webhook: string | null;
  pipeline: string | null;
}

/**
 * Resolve the effective cookie for a task, gated by its `useCookie` toggle.
 * SHARED by both recording paths (task run via buildSessionForTask, and the
 * subprocess path via TaskManager.spawnFor) so they stay in sync:
 *
 *   useCookie=false → null → anonymous danmu (comments only).
 *   useCookie=true  → task.cookies override, else the global defaultCookies.
 *
 * Returns null (never undefined) when no cookie applies; callers map to the
 * shape they need (RecordOpts.cookies is `string | undefined`).
 */
export function resolveTaskCookies(
  task: Pick<Task, "useCookie" | "cookies">,
  globalCookie: string | null,
): string | null {
  if (!task.useCookie) return null;
  return task.cookies ?? globalCookie ?? null;
}

/**
 * 房间地址归一化(存储前):无论输入什么格式,统一存成平台规范 URL(抖音=https://live.douyin.com/{web_rid})。
 *   - 裸房间号 767116735823            → https://live.douyin.com/767116735823
 *   - 带 query 的 URL …?activity_name=… → https://live.douyin.com/411477943168(剥 query)
 *   - 已规范的 URL                      → 原样
 *   - 抖音短链 v.douyin.com/XXX         → 原样(web_rid 需异步 resolveShortURL,入库前由上层解析)
 * (extractRoomSlug 取 web_rid,roomToUrl 拼回规范 URL;http 输入若非 live.douyin.com 则原样兜底)。
 */
export function normalizeRoom(room: string): string {
  const r = room.trim();
  const platform = platformForRoom(r);
  const slug = platform.extractRoomSlug(r); // URL→web_rid;裸输入→原样
  // 仅当 slug 是纯数字(真房间号:裸数字 或从 URL 提取的 web_rid)才拼规范 URL。
  // 非数字(短链 v.douyin.com/XXX 需异步解析、或未知串)原样返回,不硬拼成 URL。
  return /^\d+$/.test(slug) ? platform.roomToUrl(slug) : r;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: Number(r.id),
    room: r.room,
    platform: r.platform ?? "douyin",
    name: r.name,
    quality: r.quality,
    engine: (r.engine as EngineKind) ?? "ffmpeg",
    danmu: Number(r.danmu),
    segmentSec: Number(r.segmentSec),
    cookies: r.cookies,
    outDir: r.outDir,
    scheduleStart: r.scheduleStart,
    scheduleEnd: r.scheduleEnd,
    status: (r.status as TaskStatus) ?? "stopped",
    useCookie: Number(r.useCookie) !== 0,
    enabled: Number(r.enabled) !== 0,
    createdAt: r.createdAt,
    anchorName: r.anchorName ?? null,
    webhook: r.webhook ?? null,
    pipeline: parsePipeline(r.pipeline),
  };
}

/** 解析 pipeline JSON 列(损坏/空 → null)。 */
function parsePipeline(s: string | null): TaskPipelineConfig | null {
  if (!s) return null;
  try { return JSON.parse(s) as TaskPipelineConfig; } catch { return null; }
}

/**
 * 解析任务生效的 webhook:任务自带 ?? 全局。空串视为未设。SHARED by 合成端点(api)
 * 与录制子进程(spawner)→ 两路对同一任务用同一个 webhook。
 */
export function resolveTaskWebhook(
  task: Pick<Task, "webhook">,
  globalWebhook: string | null,
): string | null {
  const v = (task.webhook ?? "").trim();
  if (v.length > 0) return v;
  const g = (globalWebhook ?? "").trim();
  return g.length > 0 ? g : null;
}

export class TaskStore {
  readonly db: DatabaseSync;

  /** Pass an existing DatabaseSync, or a path/undefined to open one (migrated). */
  constructor(dbOrPath?: DatabaseSync | string) {
    this.db =
      typeof dbOrPath === "object" && dbOrPath !== null
        ? dbOrPath
        : openDb(dbOrPath);
  }

  addTask(input: TaskInput): Task {
    const createdAt = input.createdAt ?? new Date().toISOString();
    // 平台:显式 input.platform(校验存在) > 按 room 判别。默认 provider/画质从平台取(去抖音硬编码)。
    const platform =
      (input.platform ? getPlatform(input.platform) : undefined) ?? platformForRoom(input.room);
    // 房间地址归一化:URL 剥跟踪 query 参数存规范 URL(裸房间号不动)。
    const room = normalizeRoom(input.room);
    // quality/engine/danmu 校验唯一真理 = platform(放宽成 string 后在此补回);非法/省略 → 平台默认。
    const quality =
      input.quality && platform.qualities.includes(input.quality) ? input.quality : platform.defaultQuality;
    const engine =
      input.engine && platform.engines.includes(input.engine)
        ? input.engine
        : platform.defaultEngine;
    const stmt = this.db.prepare(
      `INSERT INTO tasks
         (room, platform, name, quality, engine, danmu, segmentSec, cookies, outDir,
          scheduleStart, scheduleEnd, status, useCookie, enabled, createdAt, webhook, pipeline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      room,
      platform.id,
      input.name ?? null,
      quality,
      engine,
      input.danmu ?? 1,
      input.segmentSec ?? 1800,
      input.cookies ?? null,
      input.outDir ?? null,
      input.scheduleStart ?? null,
      input.scheduleEnd ?? null,
      input.status ?? "stopped",
      (input.useCookie ?? true) ? 1 : 0,
      (input.enabled ?? false) ? 1 : 0,
      createdAt,
      input.webhook ?? null,
      input.pipeline != null ? JSON.stringify(input.pipeline) : null,
    );
    const id = Number(info.lastInsertRowid);
    const task = this.getTask(id);
    if (!task) throw new Error(`addTask: failed to read back task id=${id}`);
    return task;
  }

  /**
   * Update ONLY the provided fields of a task. id/createdAt/status are never
   * touched. Booleans (useCookie) are mapped to 0/1 like addTask. Returns the
   * refreshed Task, or null if the id does not exist.
   *
   * The SET clause is built dynamically from exactly the keys present in
   * `patch`, so an omitted field is left untouched at the SQL level (no
   * COALESCE / no read-modify-write).
   */
  updateTask(
    id: number,
    patch: Partial<
      Pick<
        TaskInput,
        | "room"
        | "name"
        | "quality"
        | "engine"
        | "danmu"
        | "segmentSec"
        | "cookies"
        | "outDir"
        | "scheduleStart"
        | "scheduleEnd"
        | "useCookie"
        | "enabled"
        | "webhook"
        | "pipeline"
      >
    >,
  ): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    let platform = getPlatform(existing.platform) ?? platformForRoom(existing.room);
    let platformChanged = false;

    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, val: string | number | null): void => {
      cols.push(`${col} = ?`);
      vals.push(val);
    };

    // 空 room 不落库(NOT NULL 列;web 层已挡,这里兜底跳过而非写 "")。
    // 改 room 时**按新地址重判平台**:换了平台 → 更新 platform 列 + 把 quality/recorder/danmu
    // 按新平台复校(下面 platformChanged 触发),避免「改成 B 站 URL 却还留着抖音录制器」。
    if ("room" in patch && patch.room && patch.room.trim()) {
      const room = normalizeRoom(patch.room);
      set("room", room);
      const np = platformForRoom(room);
      if (np.id !== platform.id) {
        platform = np;
        platformChanged = true;
        set("platform", np.id);
      }
    }
    if ("name" in patch) set("name", patch.name ?? null);
    // quality/engine/danmu:patch 显式给了、或平台变了 → 都要(重)校验到当前平台合法值;否则保留。
    if ("quality" in patch || platformChanged) {
      const q = "quality" in patch ? patch.quality : existing.quality;
      set("quality", q && platform.qualities.includes(q) ? q : platform.defaultQuality);
    }
    if ("engine" in patch || platformChanged) {
      const e = "engine" in patch ? patch.engine : existing.engine;
      set("engine", e && platform.engines.includes(e) ? e : platform.defaultEngine);
    }
    if ("danmu" in patch) set("danmu", patch.danmu ?? 1);
    if ("segmentSec" in patch) set("segmentSec", patch.segmentSec ?? 1800);
    if ("cookies" in patch) set("cookies", patch.cookies ?? null);
    if ("outDir" in patch) set("outDir", patch.outDir ?? null);
    if ("scheduleStart" in patch) set("scheduleStart", patch.scheduleStart ?? null);
    if ("scheduleEnd" in patch) set("scheduleEnd", patch.scheduleEnd ?? null);
    if ("useCookie" in patch) set("useCookie", patch.useCookie ? 1 : 0);
    if ("enabled" in patch) set("enabled", patch.enabled ? 1 : 0);
    if ("webhook" in patch) set("webhook", patch.webhook ?? null);
    if ("pipeline" in patch) set("pipeline", patch.pipeline != null ? JSON.stringify(patch.pipeline) : null);

    if (cols.length === 0) return this.getTask(id); // nothing to change

    vals.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${cols.join(", ")} WHERE id = ?`)
      .run(...vals);
    return this.getTask(id);
  }

  listTasks(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY id ASC`)
      .all() as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  getTask(id: number): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(id) as unknown as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  removeTask(id: number): boolean {
    const info = this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    return Number(info.changes) > 0;
  }

  setStatus(id: number, status: TaskStatus): boolean {
    const info = this.db
      .prepare(`UPDATE tasks SET status = ? WHERE id = ?`)
      .run(status, id);
    return Number(info.changes) > 0;
  }

  /** 写入自动抓取的主播名（创建时 getInfo / 录制时刷新）。空串视为清空(null)。 */
  setAnchorName(id: number, name: string | null): boolean {
    const v = name && name.trim() ? name.trim() : null;
    const info = this.db
      .prepare(`UPDATE tasks SET anchorName = ? WHERE id = ?`)
      .run(v, id);
    return Number(info.changes) > 0;
  }

  /** Flip the user-intent switch. true → daemon-managed; false → never started. */
  setEnabled(id: number, on: boolean): boolean {
    const info = this.db
      .prepare(`UPDATE tasks SET enabled = ? WHERE id = ?`)
      .run(on ? 1 : 0, id);
    return Number(info.changes) > 0;
  }

  /**
   * The GLOBAL Douyin account cookie shared by all tasks (settings key
   * `defaultCookies`, written by QR login / manual paste / `cookie set`).
   * An empty stored value is treated as unset → null.
   */
  getDefaultCookies(): string | null {
    const v = (this.getSetting("defaultCookies") ?? "").trim();
    return v.length > 0 ? v : null;
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as unknown as { value: string | null } | undefined;
    return row ? row.value : null;
  }

  /** Upsert a setting. */
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
