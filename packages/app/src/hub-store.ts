/**
 * hub-store.ts — 文件版 hub 任务配置存储(**唯一真理源 = 磁盘文件**)。
 *
 * 每个房间一份 `<hubDir>/{platform}.{roomSlug}.json`,内容 `{ room?, enabled, pipeline }`。
 * **按平台限定**:roomSlug(web_rid)只在单平台内唯一,douyin 的 123456 与 bilibili 的 123456
 * 会撞,故 key = `{platform}.{roomSlug}`(= 文件名 stem + API 路由 id;两段都不含点,按首个 `.` 切)。
 * **房间身份来自绑定的 master 任务**:create 时 API 由 `recording.sourceTaskId` 解析出
 * platform + roomSlug 作为 key;`room` 仅作显示用(由任务派生写入,可省略)。
 *
 * 设计要点(见 docs/multi-node-sync-followups.md):
 *   - **现读不缓存**:每次调用都读磁盘 → UI 与手改文件天然同步(无两份存储要对齐)。
 *   - **原子写**:写临时文件再 rename,reconciler 每 tick 现读不会读到写一半的 JSON。
 *   - **坏 JSON 跳过**:手改打错 → list 忽略该条 / get 返 null,绝不抛崩 hub。
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { platformForRoom, satisfiesCapabilities, type HubPipelineConfig, type HubRecordingConfig } from "@drec/core";
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
  /** 录制下发配置(sourceTaskId 非空 → hub 把该 task 同步到 workers 勾选的节点)。 */
  recording?: HubRecordingConfig;
  /** 选中参与该房间 hub 处理的 worker id;缺省/空 = 全部(向后兼容)。 */
  workers?: string[];
  /**
   * 该房间需要的 worker 能力(能力门控)。非空时,只有 `capabilities ⊇ requires` 的 worker 才参与
   * 该房间的录制下发与后处理;**与 workers 是交集**(先按 workers 勾选,再按 requires 过滤)。
   * 缺省/空 = 无能力要求(向后兼容)。例:`["danmu:douyin"]` → 只派给出口能拿到弹幕的节点。
   */
  requires?: string[];
  /** 列表自定义排序(可拖拽调整);越小越靠前,缺省 = 未排过序(按 key 兜底)。 */
  order?: number;
}

/** 磁盘文件的形状(key/roomSlug/platform 不存盘;room 为显示用,新规则由 source task 派生可省略)。 */
interface HubFile {
  room?: string;
  enabled?: boolean;
  pipeline?: HubPipelineConfig;
  recording?: HubRecordingConfig;
  workers?: string[];
  requires?: string[];
  order?: number;
}

/** 组合 key:平台 + 房间号,两段都不含点。 */
export function hubKey(platform: string, roomSlug: string): string {
  return `${platform}.${roomSlug}`;
}

/**
 * **深合并** pipeline 补丁(不整体替换)。
 *
 * 为什么必须合并:前端只能提交它**知道的**字段。若这里整体替换,一次只改画质/步骤的保存
 * 就会把规则里其它 pipeline 字段(`cleanup` 清理开关、`titleTemplate` 等标题模板、
 * `uploadBatchSize`/`minSegmentSec` 分段调优)静默抹掉 —— 而它们不在该表单里,
 * 用户看不出「我只是点了个保存,清理策略就没了」。这是**静默数据丢失**,必须避免。
 *
 * 语义:标量/字符串直接覆盖;`steps` 与 `upload` 这两层对象再合并一层
 * (这样「只改 steps 里的一个开关」不会把 upload 的 tag/tid/desc 清空)。
 * 显式传 `undefined` 的键**跳过**(= 不改该字段),保留其它键。
 * 注意:因此**无法**用本函数清空单个字段(需清空就传空串/null,不要传 undefined)。
 */
export function mergePipeline(
  prev: HubPipelineConfig | undefined,
  patch: HubPipelineConfig | undefined,
): HubPipelineConfig {
  const base: HubPipelineConfig = { ...(prev ?? {}) };
  if (!patch) return base;
  for (const [k, v] of Object.entries(patch) as [keyof HubPipelineConfig, unknown][]) {
    if (v === undefined) continue;
    if ((k === "steps" || k === "upload") && v && typeof v === "object") {
      base[k] = { ...(base[k] as object), ...(v as object) } as never;
    } else {
      (base as Record<string, unknown>)[k] = v;
    }
  }
  return base;
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
    recording: raw.recording,
    // workers 缺省 = undefined(= 全部 worker,向后兼容)。只在文件显式含时透出。
    workers: raw.workers,
    // requires 缺省 = undefined(= 无能力要求)。空数组视为无要求(等价缺省)。
    requires: raw.requires?.length ? raw.requires : undefined,
    order: raw.order,
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

/** 排序键:order 升序(未排过序的规则置后),同位按 key 稳定排序。 */
function byOrderThenKey(a: HubRule, b: HubRule): number {
  const oa = a.order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.order ?? Number.MAX_SAFE_INTEGER;
  return oa !== ob ? oa - ob : a.key.localeCompare(b.key);
}

/** 列出全部 hub 规则(扫 <hubDir>/*.json;坏文件跳过;order 升序、无 order 按 key 兜底)。 */
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
  return out.sort(byOrderThenKey);
}

/** 取单条(key=`{platform}.{roomSlug}`);无则 null。 */
export function getHubRule(dir: string, key: string): HubRule | null {
  return readRule(dir, key);
}

/**
 * 源任务本机抑制名单:规则启用 + 绑了 sourceTaskId + workers 显式勾选且不含 "local"、
 * 且**至少有一个确实存在的远端 worker** 会接这场的录制
 * → 该房间的录制明确交给远端节点,master 本机的源任务只当配置模板,不应再实跑
 * (避免本机持续轮询触发风控/两节点重复录制)。daemon 每 tick 现读,跟随手改文件。
 *
 * 传入 knownWorkerIds(= 当前 hub.config.json 的 worker id 集合):规则里若只剩已删除的
 * 幽灵 id,则**不抑制**本机 —— 否则会出现「本机不录、远端也没人接」的静默漏录。
 *
 * **能力门控(T-10)**:候选远端 worker 还要满足规则的 `requires`(能力 ⊇ 要求)才算「有人接」。
 * 否则会出现「本机被抑制、远端因缺能力被 reconciler 排除」→ 两头都不录的静默漏录。
 * 与 reconciler 用**同一套判定**(core 的 `satisfiesCapabilities`,单一真理源)。
 */
export function localSuppressedSourceTaskIds(
  dir: string,
  knownWorkerIds: ReadonlySet<string>,
  capabilitiesOf?: (workerId: string) => readonly string[] | undefined,
): Set<number> {
  const out = new Set<number>();
  for (const rule of listHubRules(dir)) {
    if (!rule.enabled) continue;
    const tid = rule.recording?.sourceTaskId;
    if (tid == null) continue;
    const ws = rule.workers;
    // 远端必须「存在 + 能力满足 requires」才算有人接(缺能力 → reconciler 也会排除它)。
    const hasRemote = !!ws?.some(
      (id) => id !== "local" && knownWorkerIds.has(id) && satisfiesCapabilities(capabilitiesOf?.(id), rule.requires),
    );
    if (ws && ws.length > 0 && !ws.includes("local") && hasRemote) out.add(tid);
  }
  return out;
}

/** 新建/覆盖:由显式 platform+roomSlug 定 key → 写 {key}.json(room 可选,仅作显示;缺省字段沿用已有)。 */
export function upsertHubRule(
  dir: string,
  input: {
    platform: string;
    roomSlug: string;
    room?: string;
    enabled?: boolean;
    pipeline?: HubPipelineConfig;
    recording?: HubRecordingConfig;
    workers?: string[];
    requires?: string[];
  },
): HubRule {
  const key = hubKey(input.platform, input.roomSlug);
  const existing = readRule(dir, key);
  writeRule(dir, key, {
    ...(input.room ? { room: normalizeRoom(input.room) } : {}),
    enabled: input.enabled ?? existing?.enabled ?? true,
    // pipeline **深合并**(不是整体替换):调用方(尤其 web 表单)只提交它知道的字段,
    // 整体替换会静默抹掉 cleanup / 标题模板等它没提交的字段。见 mergePipeline 注释。
    pipeline: mergePipeline(existing?.pipeline, input.pipeline),
    recording: input.recording ?? existing?.recording,
    // workers 缺省沿用已有(undefined = 全部);显式传才覆盖。
    workers: input.workers ?? existing?.workers,
    // requires 缺省沿用已有(undefined = 无能力要求);显式传才覆盖(空数组 = 清空要求)。
    requires: input.requires ?? existing?.requires,
    // order 同理:只在 reorderHubRules 显式写入;upsert/update 均沿用。
    order: existing?.order,
  });
  return getHubRule(dir, key)!;
}

/** 部分更新(enabled / pipeline / workers / requires);不存在返回 null。 */
export function updateHubRule(
  dir: string,
  key: string,
  patch: { enabled?: boolean; pipeline?: HubPipelineConfig; recording?: HubRecordingConfig; workers?: string[]; requires?: string[] },
): HubRule | null {
  const existing = readRule(dir, key);
  if (!existing) return null;
  writeRule(dir, key, {
    ...(existing.room ? { room: existing.room } : {}),
    enabled: patch.enabled ?? existing.enabled,
    pipeline: mergePipeline(existing.pipeline, patch.pipeline),
    recording: patch.recording ?? existing.recording,
    // 部分更新:未传 workers 沿用已有;传了(UI 总传非空列表)才覆盖。
    workers: patch.workers ?? existing.workers,
    requires: patch.requires ?? existing.requires,
    order: existing.order,
  });
  return getHubRule(dir, key);
}

/** 整体重排:keys 必须与现有规则集合完全相等,按下标写回 order(0..n-1)。 */
export function reorderHubRules(dir: string, keys: string[]): HubRule[] {
  const existing = listHubRules(dir);
  const byKey = new Map(existing.map((r) => [r.key, r]));
  if (keys.length !== existing.length || keys.some((k) => !byKey.has(k)) || new Set(keys).size !== keys.length) {
    throw new Error(`重排失败: 顺序与现有规则不匹配(现有 ${existing.length} 条)`);
  }
  for (let i = 0; i < keys.length; i++) {
    const r = byKey.get(keys[i])!;
    writeRule(dir, r.key, {
      ...(r.room ? { room: r.room } : {}),
      enabled: r.enabled,
      pipeline: r.pipeline,
      recording: r.recording,
      workers: r.workers,
      requires: r.requires,
      order: i,
    });
  }
  return listHubRules(dir);
}

/** 删除(删文件);文件不存在返回 false。 */
export function removeHubRule(dir: string, key: string): boolean {
  const path = join(dir, `${key}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
