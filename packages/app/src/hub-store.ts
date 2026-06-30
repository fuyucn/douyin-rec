/**
 * hub-store.ts — 文件版 hub 任务配置存储(**唯一真理源 = 磁盘文件**)。
 *
 * 每个房间一份 `<hubDir>/{platform}.{roomSlug}.json`,内容 `{ room, enabled, pipeline }`。
 * **按平台限定**:roomSlug(web_rid)只在单平台内唯一,douyin 的 123456 与 bilibili 的 123456
 * 会撞,故 key = `{platform}.{roomSlug}`(= 文件名 stem + API 路由 id;两段都不含点,按首个 `.` 切)。
 *
 * 设计要点(见 docs/multi-node-sync-followups.md):
 *   - **现读不缓存**:每次调用都读磁盘 → UI 与手改文件天然同步(无两份存储要对齐)。
 *   - **原子写**:写临时文件再 rename,reconciler 每 tick 现读不会读到写一半的 JSON。
 *   - **坏 JSON 跳过**:手改打错 → list 忽略该条 / get 返 null,绝不抛崩 hub。
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { platformForRoom, type HubPipelineConfig } from "@drec/core";
import { normalizeRoom } from "./store.js";

/** 一条 hub 规则(内存表示;持久化为 {key}.json)。 */
export interface HubRule {
  /** `{platform}.{roomSlug}` —— 文件名 stem + 路由 id(全局唯一,跨平台不撞)。 */
  key: string;
  roomSlug: string;
  platform: string;
  room: string;
  enabled: boolean;
  pipeline: HubPipelineConfig;
}

/** 磁盘文件的形状(key/roomSlug/platform 不存盘,由 room 派生)。 */
interface HubFile {
  room: string;
  enabled?: boolean;
  pipeline?: HubPipelineConfig;
}

/** 组合 key:平台 + 房间号,两段都不含点。 */
export function hubKey(platform: string, roomSlug: string): string {
  return `${platform}.${roomSlug}`;
}

/** 由 room 派生 platform + roomSlug + key(唯一真理 = 平台的 extractRoomSlug)。 */
function deriveKey(room: string): { platform: string; roomSlug: string; key: string } {
  const norm = normalizeRoom(room);
  const p = platformForRoom(norm);
  const roomSlug = p.extractRoomSlug(norm);
  return { platform: p.id, roomSlug, key: hubKey(p.id, roomSlug) };
}

/** 把文件名 stem 拆回 platform + roomSlug(按首个 `.`;无点则整体当 roomSlug、平台 douyin)。 */
function parseStem(stem: string): { platform: string; roomSlug: string } {
  const i = stem.indexOf(".");
  return i < 0 ? { platform: "douyin", roomSlug: stem } : { platform: stem.slice(0, i), roomSlug: stem.slice(i + 1) };
}

function fileToRule(stem: string, raw: HubFile): HubRule {
  const room = (raw.room ?? "").trim();
  // room 优先(权威);无 room 则从文件名 stem 还原。
  const d = room ? deriveKey(room) : { ...parseStem(stem), key: stem };
  return {
    key: d.key,
    roomSlug: d.roomSlug,
    platform: d.platform,
    room,
    // 文件省略 enabled 视为启用(文件存在=已配置;enabled 仅作开关)。
    enabled: raw.enabled !== false,
    pipeline: raw.pipeline ?? {},
  };
}

/** 读单条(缺失/坏 JSON → null,不抛)。 */
function readRule(dir: string, key: string): HubRule | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf-8")) as HubFile;
    return fileToRule(key, raw);
  } catch {
    return null;
  }
}

/** 原子写:临时文件 + rename(避免现读读到半截)。 */
function writeRule(dir: string, key: string, file: HubFile): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.json`);
  const tmp = join(dir, `.${key}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** 列出全部 hub 规则(扫 <hubDir>/*.json;坏文件跳过;按 key 排序)。 */
export function listHubRules(dir: string): HubRule[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return []; // 目录不存在 → 空
  }
  const out: HubRule[] = [];
  for (const n of names) {
    const r = readRule(dir, n.replace(/\.json$/, ""));
    if (r) out.push(r);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** 取单条(key=`{platform}.{roomSlug}`);无则 null。 */
export function getHubRule(dir: string, key: string): HubRule | null {
  return readRule(dir, key);
}

/** 新建/覆盖:由 room 派生 platform+roomSlug+key → 写 {key}.json(缺省字段沿用已有)。 */
export function upsertHubRule(
  dir: string,
  input: { room: string; enabled?: boolean; pipeline?: HubPipelineConfig },
): HubRule {
  const { key } = deriveKey(input.room);
  const existing = readRule(dir, key);
  writeRule(dir, key, {
    room: normalizeRoom(input.room),
    enabled: input.enabled ?? existing?.enabled ?? true,
    pipeline: input.pipeline ?? existing?.pipeline ?? {},
  });
  return getHubRule(dir, key)!;
}

/** 部分更新(enabled / pipeline);不存在返回 null。 */
export function updateHubRule(
  dir: string,
  key: string,
  patch: { enabled?: boolean; pipeline?: HubPipelineConfig },
): HubRule | null {
  const existing = readRule(dir, key);
  if (!existing) return null;
  writeRule(dir, key, {
    room: existing.room,
    enabled: patch.enabled ?? existing.enabled,
    pipeline: patch.pipeline ?? existing.pipeline,
  });
  return getHubRule(dir, key);
}

/** 删除(删文件);文件不存在返回 false。 */
export function removeHubRule(dir: string, key: string): boolean {
  const path = join(dir, `${key}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
