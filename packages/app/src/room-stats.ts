/**
 * room-stats.ts — 直播统计(Stats tab,plans/041)的数据底座。
 *
 * 解决的问题:节点上的录像源会被收尾清理删掉,`sync_candidates` 也只覆盖「已经跑过管线」的场次,
 * 于是「这个房间每天几点开播、录了多久、压在哪两个节点上」这类问题每次都得靠翻文件/SSH 临时拼。
 * 这里在 **master 对账拿到节点清单的那一刻**顺手落库(`<root>/db/room-stats.db`),历史不再随源文件消失。
 *
 * 设计约束:
 * - **采集是旁路**:任何失败只记一行日志,绝不向对账流程抛(统计坏掉不能影响录制/上传)。
 * - **跨节点去重**:同一场可能被两个节点同时录(冗余),库内按 `(workerId, platform, roomSlug, startMs)`
 *   分行保留(节点负载要真值),聚合时再按时间窗合并成「一场直播」。
 * - **时区口径** = 设置时区(core `zonedStamp`),与分段命名/标题/hub 场次同一口径,不看宿主机本地时区。
 * - 库内只存事实(起止/时长/缺口/节点),所有派生指标(每小时、热力图、典型时段)在查询时算:
 *   口径改了不用回填历史。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  zonedStamp,
  type StatsDTO,
  type StatsHeatmapCellDTO,
  type StatsNodeLoadDTO,
  type StatsOverviewDTO,
  type StatsRoomRowDTO,
  type StatsSessionInput,
} from "@drec/core";

/** 保留期:120 天。够回看季度规律,又不至于把库撑大(每天 ~50 行量级)。 */
export const STATS_RETAIN_MS = 120 * 24 * 3600_000;

/**
 * 合并容差:同房间两段录像间隔 ≤ 10 分钟视为「同一场」。
 * 比录制端的 `SAME_BROADCAST_GAP_MS`(30 分钟)紧 —— 统计只想去掉「同一场被多节点各录一份」和
 * 录制端重连抖动,不想把「一晚两场」也算成一场。
 */
export const STATS_MERGE_GAP_MS = 10 * 60_000;

/** 库里的一行 = 一个节点上的一次会话录制。 */
export interface StoredSession {
  workerId: string;
  platform: string;
  roomSlug: string;
  startMs: number;
  endMs: number;
  durationSec: number;
  gapSec: number;
  danmuCount: number | null;
  bytes: number | null;
  title: string | null;
  lastSeenAt: number;
}

/** `<dataRoot>/db/room-stats.db`。 */
export function roomStatsDbPath(dataRoot: string): string {
  return `${dataRoot}/db/room-stats.db`;
}

// 每个 reason 的最近一次告警时刻；5 分钟内同 reason 不重复刷屏，避免库长期不可用时日志被占满，
// 但也不让第一次失败之后永远静默（AGENTS「出错路径必须不静默」）。
const WARN_THROTTLE_MS = 5 * 60_000;
const lastWarnAt = new Map<string, number>();
function warnThrottled(reason: string, message: string): void {
  const now = Date.now();
  const last = lastWarnAt.get(reason) ?? 0;
  if (now - last < WARN_THROTTLE_MS) return;
  lastWarnAt.set(reason, now);
  console.warn(message);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS room_sessions (
  workerId   TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  roomSlug   TEXT    NOT NULL,
  startMs    INTEGER NOT NULL,
  endMs      INTEGER NOT NULL,
  durationSec REAL   NOT NULL DEFAULT 0,
  gapSec     REAL   NOT NULL DEFAULT 0,
  danmuCount INTEGER,
  bytes      INTEGER,
  title      TEXT,
  sessionBase TEXT,
  firstSeenAt INTEGER NOT NULL,
  lastSeenAt  INTEGER NOT NULL,
  PRIMARY KEY (workerId, platform, roomSlug, startMs)
);
CREATE INDEX IF NOT EXISTS room_sessions_start ON room_sessions(startMs);
`;

function openDb(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    // WAL 首开要排他锁,与被接管/并发进程偶发冲突时直接报错 —— 统计不做重试,失败即放弃本轮。
    try { db.exec("PRAGMA journal_mode=WAL"); } catch { /* 已有 WAL/被占用:继续用当前模式 */ }
    db.exec("PRAGMA busy_timeout=2000");
    db.exec(SCHEMA);
  }
  return db;
}

/**
 * 把一次节点清单里与统计相关的会话并入库。
 * @returns 实际写入(含更新)的行数;失败返回 0 且不抛。
 */
export function recordRoomSessions(
  dbPath: string,
  workerId: string,
  sessions: readonly StatsSessionInput[],
  now = Date.now(),
): number {
  if (!sessions.length) return 0;
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = openDb(dbPath, false);
    const stmt = db.prepare(`
      INSERT INTO room_sessions
        (workerId, platform, roomSlug, startMs, endMs, durationSec, gapSec, danmuCount, bytes, title, sessionBase, firstSeenAt, lastSeenAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workerId, platform, roomSlug, startMs) DO UPDATE SET
        -- 录制中每轮对账都会右移 endMs:取最大值,不能让一轮更早的观测把进度改回去。
        endMs       = MAX(room_sessions.endMs, excluded.endMs),
        durationSec = MAX(room_sessions.durationSec, excluded.durationSec),
        gapSec      = MAX(room_sessions.gapSec, excluded.gapSec),
        danmuCount  = COALESCE(excluded.danmuCount, room_sessions.danmuCount),
        bytes       = COALESCE(excluded.bytes, room_sessions.bytes),
        title       = COALESCE(excluded.title, room_sessions.title),
        sessionBase = COALESCE(excluded.sessionBase, room_sessions.sessionBase),
        lastSeenAt  = excluded.lastSeenAt
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of sessions) {
        stmt.run(
          workerId, s.platform, s.roomSlug, Math.round(s.startMs), Math.round(s.endMs),
          s.durationSec, s.totalGapSec ?? 0, s.danmuCount ?? null, s.totalBytes ?? null,
          s.title ?? null, s.sessionBase ?? null, now, now,
        );
      }
      // 保留期清理放在同一事务里:一次写入至少顺带一次有界清理,不额外起定时器。
      db.prepare("DELETE FROM room_sessions WHERE startMs < ?").run(now - STATS_RETAIN_MS);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* 事务已结束 */ }
      throw e;
    }
    return sessions.length;
  } catch (e) {
    warnThrottled("record", `[room-stats] 采集失败(不影响录制,后续轮次会重试): ${String((e as Error)?.message ?? e)}`);
    return 0;
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

/** 读窗口内的会话行(与窗口有交集的都算:跨零点的长场次不会被截掉)。 */
export function readStatsSessions(dbPath: string, sinceMs: number): StoredSession[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = openDb(dbPath, true);
    const rows = db.prepare(`
      SELECT workerId, platform, roomSlug, startMs, endMs, durationSec, gapSec, danmuCount, bytes, title, lastSeenAt
      FROM room_sessions WHERE endMs >= ? OR startMs >= ?
    `).all(sinceMs, sinceMs) as Record<string, unknown>[];
    return rows.map((r) => ({
      workerId: String(r.workerId),
      platform: String(r.platform),
      roomSlug: String(r.roomSlug),
      startMs: Number(r.startMs),
      endMs: Number(r.endMs),
      durationSec: Number(r.durationSec ?? 0),
      gapSec: Number(r.gapSec ?? 0),
      danmuCount: r.danmuCount == null ? null : Number(r.danmuCount),
      bytes: r.bytes == null ? null : Number(r.bytes),
      title: r.title == null ? null : String(r.title),
      lastSeenAt: Number(r.lastSeenAt ?? 0),
    }));
  } catch (e) {
    warnThrottled("read", `[room-stats] 读取失败: ${String((e as Error)?.message ?? e)}`);
    return [];
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

/** 最近一次采集时间(任一 worker);null = 从未采集 / 库不存在。 */
export function lastCollectionAt(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = openDb(dbPath, true);
    const row = db.prepare("SELECT MAX(lastSeenAt) AS last FROM room_sessions").get() as { last?: number | null } | undefined;
    return row?.last == null ? null : Number(row.last);
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

// ── 聚合(纯函数,单测覆盖)──────────────────────────────────────────────────

/** 配置侧的单个房间(由 API 层从任务 + hub 规则算好传入,聚合本身不碰文件)。 */
export interface StatsRoomInfo {
  platform: string;
  roomSlug: string;
  anchorName: string | null;
  enabled: boolean;
  /** rolling / stage / upload。 */
  uploadMode: string;
  outputFormat: string;
  engine: string;
  danmu: boolean;
  /** 已启用的规则分配的节点(workerId)。 */
  workers: string[];
}

export interface BuildStatsInput {
  sessions: StoredSession[];
  rooms: StatsRoomInfo[];
  /** workerId → 显示名(local / video-rec / …)。 */
  workerNames: Record<string, string | null>;
  windowDays: number;
  now: number;
  timeZone: string;
}

interface Interval { startMs: number; endMs: number }

function keyOf(platform: string, roomSlug: string): string {
  return `${platform}.${roomSlug}`;
}

function dowOfDate(date: string): number {
  // 0=周一 … 6=周日(与 DTO 一致;`getUTCDay` 是 0=周日,故 +6 取模)。
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

interface LocalParts { date: string; hour: number; minute: number; second: number; msPart: number }
function localParts(ms: number, tz: string): LocalParts {
  const z = zonedStamp(ms, tz);
  return {
    date: z.date,
    hour: Number(z.hh),
    minute: Number(z.mm),
    second: Number(z.ss),
    msPart: ((ms % 1000) + 1000) % 1000,
  };
}

/**
 * 把一个区间按**本地整点**切碎累加进 (dow,hour) 桶。
 * 走「到下一个整点还差多久」而不是「按 step 累加」:DST 切换也不会漂。
 */
function addToHeatmap(bucket: Map<string, number>, startMs: number, endMs: number, tz: string): void {
  let cur = startMs;
  // 24h 场次 ≈ 24 次迭代;上限仅防御异常区间(start=0 之类),不属于业务限制。
  for (let guard = 0; cur < endMs && guard < 10_000; guard++) {
    const p = localParts(cur, tz);
    const remain = 3_600_000 - (p.minute * 60_000 + p.second * 1_000 + p.msPart);
    const step = Math.min(remain, endMs - cur);
    const cell = `${dowOfDate(p.date)}:${p.hour}`;
    bucket.set(cell, (bucket.get(cell) ?? 0) + step / 3_600_000);
    cur += step;
  }
}

function cellsOf(bucket: Map<string, number>): StatsHeatmapCellDTO[] {
  const out: StatsHeatmapCellDTO[] = [];
  for (const [k, v] of bucket) {
    const [dow, hour] = k.split(":");
    out.push({ dow: Number(dow), hour: Number(hour), hours: Math.round(v * 100) / 100 });
  }
  out.sort((a, b) => a.dow - b.dow || a.hour - b.hour);
  return out;
}

/** 按容差合并区间;同一场被多节点各录一份会并成一条。 */
function mergeIntervals(intervals: readonly Interval[], gapMs: number): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.startMs <= last.endMs + gapMs) last.endMs = Math.max(last.endMs, it.endMs);
    else out.push({ startMs: it.startMs, endMs: it.endMs });
  }
  return out;
}

/** 每个节点各自合并后的区间(计算「同一场同时在录几个节点」用)。 */
function mergePerWorker(rows: readonly StoredSession[], gapMs: number): Map<string, Interval[]> {
  const byWorker = new Map<string, Interval[]>();
  for (const r of rows) {
    const list = byWorker.get(r.workerId) ?? byWorker.set(r.workerId, []).get(r.workerId)!;
    list.push({ startMs: r.startMs, endMs: r.endMs });
  }
  const out = new Map<string, Interval[]>();
  for (const [w, list] of byWorker) out.set(w, mergeIntervals(list, gapMs));
  return out;
}

/** 峰值同时占用:扫事件端点。 */
function peakConcurrent(intervals: readonly Interval[]): number {
  const events: { at: number; delta: number }[] = [];
  for (const it of intervals) {
    if (it.endMs <= it.startMs) continue;
    events.push({ at: it.startMs, delta: 1 }, { at: it.endMs, delta: -1 });
  }
  // 同一时刻先处理结束再处理开始:相邻(首尾相接)不算重叠。
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let cur = 0;
  let max = 0;
  for (const e of events) {
    cur += e.delta;
    if (cur > max) max = cur;
  }
  return max;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function argmaxHour(histogram: Map<number, number>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [hour, count] of histogram) {
    if (count > bestCount) { best = hour; bestCount = count; }
  }
  return best;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 由库内事实 + 配置快照算出整页统计。窗口外的部分一律不计。 */
export function buildStats(input: BuildStatsInput): StatsDTO {
  const { sessions, rooms, workerNames, windowDays, now, timeZone } = input;
  const windowStart = now - windowDays * 86_400_000;
  const roomByKey = new Map(rooms.map((r) => [keyOf(r.platform, r.roomSlug), r]));

  const byRoom = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    // 与窗口求交:跨窗口边界的长场次只算落在窗口内的部分(挖掉窗口外的一截)。
    const startMs = Math.max(s.startMs, windowStart);
    const endMs = Math.min(s.endMs, now);
    if (endMs <= startMs) continue;
    const k = keyOf(s.platform, s.roomSlug);
    (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push({ ...s, startMs, endMs });
  }

  const globalHeat = new Map<string, number>();
  const rows: StatsRoomRowDTO[] = [];
  let totalBroadcastHours = 0;
  let totalSessions = 0;

  for (const [key, list] of byRoom) {
    const info = roomByKey.get(key);
    const merged = mergeIntervals(list, STATS_MERGE_GAP_MS);
    const perWorker = mergePerWorker(list, STATS_MERGE_GAP_MS);
    const hours = merged.reduce((sum, m) => sum + (m.endMs - m.startMs) / 3_600_000, 0);
    totalBroadcastHours += hours;
    totalSessions += merged.length;

    const roomHeat = new Map<string, number>();
    const startHist = new Map<number, number>();
    const endHist = new Map<number, number>();
    const days = new Set<string>();
    for (const m of merged) {
      addToHeatmap(roomHeat, m.startMs, m.endMs, timeZone);
      addToHeatmap(globalHeat, m.startMs, m.endMs, timeZone);
      const st = localParts(m.startMs, timeZone);
      // 收播整点取「结束前一刻」的整点:12:00:00 整点收播读作 11 点场结束更符合直觉。
      const endHour = localParts(Math.max(m.startMs, m.endMs - 1), timeZone).hour;
      startHist.set(st.hour, (startHist.get(st.hour) ?? 0) + 1);
      endHist.set(endHour, (endHist.get(endHour) ?? 0) + 1);
      days.add(st.date);
      days.add(localParts(m.endMs, timeZone).date);
    }

    let maxNodes = 0;
    for (const [, ivs] of perWorker) {
      const p = peakConcurrent(ivs);
      if (p > maxNodes) maxNodes = p;
    }
    const nodeSessions = new Map<string, number>();
    for (const s of list) nodeSessions.set(s.workerId, (nodeSessions.get(s.workerId) ?? 0) + 1);

    const durations = merged.map((m) => (m.endMs - m.startMs) / 3_600_000);
    rows.push({
      key,
      platform: list[0].platform,
      roomSlug: list[0].roomSlug,
      anchorName: info?.anchorName ?? null,
      enabled: info?.enabled ?? false,
      uploadMode: info?.uploadMode ?? "",
      outputFormat: info?.outputFormat ?? "",
      sessions: merged.length,
      totalHours: round2(hours),
      perDayHours: round2(hours / windowDays),
      avgHours: round2(durations.reduce((a, b) => a + b, 0) / (durations.length || 1)),
      medianHours: round2(median(durations)),
      firstStartMs: merged[0]?.startMs ?? null,
      lastEndMs: merged.length ? merged[merged.length - 1].endMs : null,
      typicalStartHour: argmaxHour(startHist),
      typicalEndHour: argmaxHour(endHist),
      days: days.size,
      nodes: [...nodeSessions.entries()]
        .map(([workerId, n]) => ({ workerId, name: workerNames[workerId] ?? null, sessions: n }))
        .sort((a, b) => b.sessions - a.sessions),
      maxNodes,
      heatmap: cellsOf(roomHeat),
    });
  }
  rows.sort((a, b) => b.perDayHours - a.perDayHours || a.key.localeCompare(b.key));

  // ── 节点负载(按节点真值,含冗余录制)──────────────────────────────────────
  const rawByWorker = new Map<string, StoredSession[]>();
  for (const s of sessions) {
    const startMs = Math.max(s.startMs, windowStart);
    const endMs = Math.min(s.endMs, now);
    if (endMs <= startMs) continue;
    (rawByWorker.get(s.workerId) ?? rawByWorker.set(s.workerId, []).get(s.workerId)!).push({ ...s, startMs, endMs });
  }
  const workerIds = new Set<string>([...Object.keys(workerNames), ...rawByWorker.keys()]);
  for (const r of rooms) for (const w of r.workers) workerIds.add(w);
  const nodeLoad: StatsNodeLoadDTO[] = [...workerIds].map((workerId) => {
    const list = rawByWorker.get(workerId) ?? [];
    const intervals = [...list].map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
    return {
      workerId,
      name: workerNames[workerId] ?? null,
      assignedRooms: rooms.filter((r) => r.enabled && r.workers.includes(workerId)).length,
      sessions: list.length,
      hours: round2(list.reduce((sum, s) => sum + (s.endMs - s.startMs) / 3_600_000, 0)),
      peakConcurrent: peakConcurrent(intervals),
    };
  }).sort((a, b) => b.hours - a.hours);

  const countBy = <T>(items: readonly T[], pick: (t: T) => string): { mode: string; count: number }[] => {
    const m = new Map<string, number>();
    for (const it of items) { const k = pick(it); if (!k) continue; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count);
  };

  const overview: StatsOverviewDTO = {
    windowDays,
    knownRooms: rooms.length,
    enabledRooms: rooms.filter((r) => r.enabled).length,
    observedRooms: rows.length,
    sessions: totalSessions,
    broadcastHours: round2(totalBroadcastHours),
    uploadModes: countBy(rooms, (r) => r.uploadMode),
    outputFormats: countBy(rooms, (r) => r.outputFormat).map(({ mode, count }) => ({ format: mode, count })),
    platforms: countBy(rooms, (r) => r.platform).map(({ mode, count }) => ({ platform: mode, count })),
    engines: countBy(rooms, (r) => r.engine).map(({ mode, count }) => ({ engine: mode, count })),
    danmu: { on: rooms.filter((r) => r.danmu).length, off: rooms.filter((r) => !r.danmu).length },
    nodeLoad,
  };

  return {
    generatedAt: now,
    timeZone,
    windowDays,
    overview,
    rooms: rows,
    heatmap: cellsOf(globalHeat),
    empty: sessions.length === 0,
    lastCollectedAt: sessions.reduce((max, s) => (s.lastSeenAt > max ? s.lastSeenAt : max), 0) || null,
  };
}
