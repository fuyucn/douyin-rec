/**
 * rolling-manifest.ts — 边录边传进度清单 v3(`{base}.rolling.json`)的**纯逻辑**(rank 0,无 IO)。
 *
 * 背景(#57 R2 / #46):v2 清单只有 confirmed/ambiguous/uploading 三组散字段,没有「谁在写」的租约,
 * 也没有逐段状态机,重启后旧会话的清单无人接管、读到损坏文件会被当成新会话(重复建稿)。本模块提供:
 *   - 分段状态机 + 转换白名单({@link canSegTransition},不允许强制写状态);
 *   - 解析:区分「合法 / 损坏」({@link parseRollingManifest});v2 清单按旧字段重建 segs;
 *   - 旧字段镜像({@link serializeRollingManifest}):每次写都由 segs 派生 segments/confirmed/ambiguous/uploading,
 *     旧主控与旧节点包照常读;
 *   - 租约判定({@link leaseTakeable});
 *   - 启动接管的**判定表**({@link decideIntentSettlement}):纯函数,回读 IO 在 app 层。
 *
 * 硬规则:任何一步都不得自动建稿;无法证明「未提交」就转人工。
 */

export const ROLLING_MANIFEST_SCHEMA_VERSION = 3;

/** 租约有效期;心跳按 {@link LEASE_HEARTBEAT_MS} 续期。 */
export const LEASE_MS = 90_000;
export const LEASE_HEARTBEAT_MS = 20_000;
/** 回读核对的最小间隔(容忍 B 站分 P 数同步延迟):两次一致才判定「未提交」。 */
export const READBACK_GAP_MS = 3 * 60_000;
/** 无租约(v2 老清单)的最小静置时长:低于它视为老版本进程仍可能在写,不接管。 */
export const LEGACY_IDLE_MS = 10 * 60_000;

/**
 * 分段状态:
 *   open(正在写)→ sealed(已封口)→ uploading(意图已落盘、上传中)→ acked(已确认)→ sourceDeleted(源已删);
 *   ambiguous = 结果不确定(可能已提交),needs_manual = 已确认需人工,skipped = 碎片段不上传。
 * ambiguous / needs_manual / skipped / sourceDeleted 对镜像字段的含义见 {@link deriveMirror}。
 */
export type SegStatus =
  | "open" | "sealed" | "uploading" | "acked" | "ambiguous" | "needs_manual" | "skipped" | "sourceDeleted";

const SEG_STATUSES: ReadonlySet<string> = new Set([
  "open", "sealed", "uploading", "acked", "ambiguous", "needs_manual", "skipped", "sourceDeleted",
]);

/** 段状态转换白名单(唯一真理源)。终态:needs_manual / skipped / sourceDeleted。 */
const SEG_TRANSITIONS: Readonly<Record<SegStatus, readonly SegStatus[]>> = {
  open: ["sealed"],
  sealed: ["uploading", "skipped", "needs_manual"],
  // uploading → sealed:回读证实未提交,放回可续传队列。
  uploading: ["acked", "ambiguous", "sealed", "needs_manual"],
  acked: ["sourceDeleted"],
  // ambiguous → acked:回读证实已提交(补确认);→ sealed:证实未提交。
  ambiguous: ["acked", "sealed", "needs_manual"],
  needs_manual: [],
  skipped: [],
  sourceDeleted: [],
};

export function canSegTransition(from: SegStatus, to: SegStatus): boolean {
  return from === to || SEG_TRANSITIONS[from].includes(to);
}

export interface SegRecord {
  index: number;
  path: string;
  status: SegStatus;
  /** 上传尝试次数(含被杀的那次)。 */
  attempts?: number;
  bytes?: number;
  /** 转人工 / 跳过 / 不确定的原因(日志与排障;不含隐私)。 */
  reason?: string;
}

/** 先写意图再执行:上传动作前落盘,被杀后凭它回读核对。 */
export interface RollingIntent {
  attemptId: string;
  kind: "create" | "append";
  index: number;
  startedAt: number;
}

export interface RollingLease {
  pid: number;
  /** 租约到期时刻(epoch ms);心跳续期。 */
  until: number;
  /** 持有者实例 id(同进程多实例区分;pid 单独不够)。 */
  holder: string;
}

export interface RollingManifest {
  schemaVersion: number;
  streamKey: string;
  sessionBase: string;
  room?: { platform: string; roomSlug: string };
  segs: SegRecord[];
  bv?: string;
  intent?: RollingIntent;
  lease?: RollingLease;
  startMs?: number;
  /** 策略快照(可选):建稿时生效的可见性等,供接管续传保持一致。 */
  policy?: { private?: boolean };
  updatedAt: number;
}

/** 旧字段镜像(旧主控/旧节点包读它们)。 */
export interface LegacyMirror {
  segments: Array<{ index: number; path: string }>;
  confirmed: number[];
  ambiguous?: number[];
  uploading?: { index: number; kind: "create" | "append" };
}

export function deriveMirror(m: Pick<RollingManifest, "segs" | "intent">): LegacyMirror {
  const sorted = [...m.segs].sort((a, b) => a.index - b.index);
  const confirmed = sorted.filter((s) => s.status === "acked" || s.status === "sourceDeleted").map((s) => s.index);
  // needs_manual 也镜像进 ambiguous:旧主控只认 ambiguous 来转人工。skipped 不入镜像(与 v2 行为一致:仅留 ts)。
  const ambiguous = sorted.filter((s) => s.status === "ambiguous" || s.status === "needs_manual").map((s) => s.index);
  const mirror: LegacyMirror = {
    segments: sorted.map((s) => ({ index: s.index, path: s.path })),
    confirmed,
  };
  if (ambiguous.length > 0) mirror.ambiguous = ambiguous;
  if (m.intent) mirror.uploading = { index: m.intent.index, kind: m.intent.kind };
  return mirror;
}

/** 序列化:schemaVersion=3 + segs + 同步镜像。每次写盘都走这里,保证镜像不漂移。 */
export function serializeRollingManifest(m: RollingManifest, nowMs: number): string {
  const out: RollingManifest & LegacyMirror = {
    ...m,
    schemaVersion: ROLLING_MANIFEST_SCHEMA_VERSION,
    updatedAt: nowMs,
    ...deriveMirror(m),
  };
  if (!out.ambiguous) delete out.ambiguous;
  if (!out.intent) delete out.intent;
  if (!out.uploading) delete out.uploading;
  return JSON.stringify(out);
}

export type ParsedManifest =
  | { kind: "ok"; manifest: RollingManifest; legacy: boolean }
  | { kind: "corrupt"; reason: string };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 解析清单文本。**解析失败 ≠ 不存在**:损坏返回 `corrupt`,调用方必须转人工,绝不当新会话处理。
 * v3 严格校验 segs;v1/v2 按旧字段重建 segs(类型错误同样判损坏)。
 */
export function parseRollingManifest(text: string, expectedBase?: string): ParsedManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    return { kind: "corrupt", reason: `JSON 解析失败: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  if (!isObj(raw)) return { kind: "corrupt", reason: "根节点不是对象" };
  const sessionBase = typeof raw.sessionBase === "string" && raw.sessionBase ? raw.sessionBase : expectedBase;
  if (!sessionBase) return { kind: "corrupt", reason: "缺少 sessionBase" };
  const bv = typeof raw.bv === "string" && raw.bv ? raw.bv : undefined;
  const base = {
    streamKey: typeof raw.streamKey === "string" ? raw.streamKey : "",
    sessionBase,
    bv,
    startMs: isNum(raw.startMs) && raw.startMs > 0 ? raw.startMs : undefined,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : 0,
    room: isObj(raw.room) && typeof raw.room.platform === "string" && typeof raw.room.roomSlug === "string"
      ? { platform: raw.room.platform, roomSlug: raw.room.roomSlug } : undefined,
  };

  if (raw.schemaVersion === ROLLING_MANIFEST_SCHEMA_VERSION) {
    if (!Array.isArray(raw.segs)) return { kind: "corrupt", reason: "v3 缺少 segs 数组" };
    const segs: SegRecord[] = [];
    for (const s of raw.segs) {
      if (!isObj(s) || !isNum(s.index) || typeof s.path !== "string" || typeof s.status !== "string" || !SEG_STATUSES.has(s.status)) {
        return { kind: "corrupt", reason: "v3 segs 含非法条目" };
      }
      segs.push({
        index: s.index, path: s.path, status: s.status as SegStatus,
        attempts: isNum(s.attempts) ? s.attempts : undefined,
        bytes: isNum(s.bytes) ? s.bytes : undefined,
        reason: typeof s.reason === "string" ? s.reason : undefined,
      });
    }
    let intent: RollingIntent | undefined;
    if (raw.intent != null) {
      const i = raw.intent;
      if (!isObj(i) || !isNum(i.index) || (i.kind !== "create" && i.kind !== "append") || typeof i.attemptId !== "string") {
        return { kind: "corrupt", reason: "v3 intent 非法" };
      }
      intent = { attemptId: i.attemptId, kind: i.kind, index: i.index, startedAt: isNum(i.startedAt) ? i.startedAt : 0 };
    }
    let lease: RollingLease | undefined;
    if (raw.lease != null) {
      const l = raw.lease;
      if (!isObj(l) || !isNum(l.pid) || !isNum(l.until)) return { kind: "corrupt", reason: "v3 lease 非法" };
      lease = { pid: l.pid, until: l.until, holder: typeof l.holder === "string" ? l.holder : "" };
    }
    const policy = isObj(raw.policy) ? { private: typeof raw.policy.private === "boolean" ? raw.policy.private : undefined } : undefined;
    return { kind: "ok", legacy: false, manifest: { ...base, schemaVersion: 3, segs, intent, lease, policy } };
  }

  // ── v1/v2:按旧字段重建 segs ──
  const numArr = (v: unknown, name: string): number[] | string => {
    if (v == null) return [];
    if (!Array.isArray(v) || !v.every(isNum)) return `${name} 类型非法`;
    return v as number[];
  };
  const confirmed = numArr(raw.confirmed, "confirmed");
  const ambiguous = numArr(raw.ambiguous, "ambiguous");
  if (typeof confirmed === "string") return { kind: "corrupt", reason: confirmed };
  if (typeof ambiguous === "string") return { kind: "corrupt", reason: ambiguous };
  if (raw.segments != null && !Array.isArray(raw.segments)) return { kind: "corrupt", reason: "segments 类型非法" };
  const legacySegs: Array<{ index: number; path: string }> = [];
  for (const s of (raw.segments as unknown[] | undefined) ?? []) {
    if (!isObj(s) || !isNum(s.index) || typeof s.path !== "string") return { kind: "corrupt", reason: "segments 含非法条目" };
    legacySegs.push({ index: s.index, path: s.path });
  }
  let intent: RollingIntent | undefined;
  if (raw.uploading != null) {
    const u = raw.uploading;
    if (!isObj(u) || !isNum(u.index) || (u.kind !== "create" && u.kind !== "append")) {
      return { kind: "corrupt", reason: "uploading 标记非法" };
    }
    intent = { attemptId: `legacy-${u.index}`, kind: u.kind, index: u.index, startedAt: base.updatedAt };
  }
  const confirmedSet = new Set(confirmed);
  const ambiguousSet = new Set(ambiguous);
  const byIndex = new Map<number, SegRecord>();
  for (const s of legacySegs) byIndex.set(s.index, { index: s.index, path: s.path, status: "sealed" });
  // confirmed / ambiguous 里出现但 segments 没有的段号也要保留(path 未知 → 空串)。
  for (const i of [...confirmedSet, ...ambiguousSet, ...(intent ? [intent.index] : [])]) {
    if (!byIndex.has(i)) byIndex.set(i, { index: i, path: "", status: "sealed" });
  }
  for (const s of byIndex.values()) {
    if (confirmedSet.has(s.index)) s.status = "acked";
    else if (ambiguousSet.has(s.index)) s.status = "ambiguous";
    else if (intent && intent.index === s.index) s.status = "uploading";
  }
  const segs = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { kind: "ok", legacy: true, manifest: { ...base, schemaVersion: 2, segs, intent } };
}

export function setSegStatus(m: RollingManifest, index: number, to: SegStatus, patch: Partial<SegRecord> = {}): RollingManifest {
  const cur = m.segs.find((s) => s.index === index);
  if (!cur) throw new Error(`[rolling-manifest] 段 ${index} 不存在,无法转 ${to}`);
  if (!canSegTransition(cur.status, to)) {
    throw new Error(`[rolling-manifest] 非法段状态转换 ${cur.status} → ${to}(段 ${index})`);
  }
  return { ...m, segs: m.segs.map((s) => (s.index === index ? { ...s, ...patch, status: to } : s)) };
}

export const confirmedIndices = (m: Pick<RollingManifest, "segs">): number[] =>
  m.segs.filter((s) => s.status === "acked" || s.status === "sourceDeleted").map((s) => s.index);
export const blockedIndices = (m: Pick<RollingManifest, "segs">): number[] =>
  m.segs.filter((s) => s.status === "ambiguous" || s.status === "needs_manual").map((s) => s.index);

/** 清单里是否还有需要接管处理的事(完全收口的清单不抢租约、不读回)。 */
export function needsTakeover(m: RollingManifest, sourceExists: (path: string) => boolean): boolean {
  if (m.intent) return true;
  return m.segs.some((s) => {
    switch (s.status) {
      case "open": case "sealed": case "uploading": return true;
      case "acked": return !!s.path && sourceExists(s.path); // 确认了但源还在 → 补删
      default: return false;
    }
  });
}

/**
 * 租约是否**可接管**:租约不存在(老清单)→ 仅静置超过 {@link LEGACY_IDLE_MS} 才可;
 * 否则「已过期 或 持有 pid 已不存在」才可(租约有效 = 有人在写,跳过)。
 */
export function leaseTakeable(
  m: Pick<RollingManifest, "lease" | "updatedAt">,
  nowMs: number,
  pidAlive: (pid: number) => boolean,
  opts: { fileMtimeMs?: number; legacyIdleMs?: number } = {},
): boolean {
  const l = m.lease;
  if (!l) {
    const last = Math.max(m.updatedAt || 0, opts.fileMtimeMs ?? 0);
    return nowMs - last >= (opts.legacyIdleMs ?? LEGACY_IDLE_MS);
  }
  return l.until <= nowMs || !pidAlive(l.pid);
}

/** 回读结果:分 P 数(null = 查不到)或稿件消失。 */
export type Readback = { parts: number | null } | { gone: true };

export type IntentSettlement =
  | { action: "none" }                                  // 无意图,无需结算
  | { action: "ack" }                                   // 意图那段其实已提交 → 补确认
  | { action: "resume" }                                // 证实未提交 → 可续传
  | { action: "manual"; reason: string };               // 转人工(必须日志 + 通知)

/**
 * 启动接管判定表(纯函数)。`reads` = 按时间顺序的回读(第 2 次起间隔 ≥ {@link READBACK_GAP_MS}):
 *   - 无意图 → none;
 *   - create 且无稿件号 → 转人工(绝不重建稿);append 且无稿件号 → 转人工(状态不一致);
 *   - append:分 P 数 = 已确认数+1 → ack(已提交,一次即可定论);
 *     分 P 数 = 已确认数 → **须两次回读一致**才 resume(B 站延迟:首次可能还没同步);首次后需要等待 → 返回 needMore;
 *   - 其它(查不到 / 数量异常 / 稿件消失 / 两次不一致)→ 转人工。
 */
export function decideIntentSettlement(
  m: Pick<RollingManifest, "intent" | "bv" | "segs">,
  reads: readonly Readback[],
): IntentSettlement | { action: "needMore" } {
  const it = m.intent;
  if (!it) return { action: "none" };
  if (!m.bv) {
    return { action: "manual", reason: it.kind === "create" ? "建稿中断且无稿件号(可能已建稿),不重建稿" : "追加意图但无稿件号(状态不一致)" };
  }
  if (it.kind === "create") {
    // 有稿件号 + create 意图:建稿已成功但确认没落盘?v3 写法把 bv 与确认并入同一次写,出现即状态不一致。
    return { action: "manual", reason: "create 意图与稿件号并存(状态不一致)" };
  }
  const expected = confirmedIndices(m).length;
  const first = reads[0];
  if (!first) return { action: "needMore" };
  if ("gone" in first) return { action: "manual", reason: "回读发现稿件不存在" };
  if (first.parts == null) return { action: "manual", reason: "回读分P数失败,无法确认是否已提交" };
  if (first.parts === expected + 1) return { action: "ack" };
  if (first.parts !== expected) return { action: "manual", reason: `分P数异常(${first.parts} ≠ 已确认 ${expected} / ${expected + 1})` };
  // 首次 = 已确认数:可能是 B 站延迟,必须再读一次。
  const second = reads[1];
  if (!second) return { action: "needMore" };
  if ("gone" in second) return { action: "manual", reason: "二次回读发现稿件不存在" };
  if (second.parts === expected + 1) return { action: "ack" };
  if (second.parts === expected) return { action: "resume" };
  return { action: "manual", reason: `两次回读不一致或异常(${String(second.parts)})` };
}
