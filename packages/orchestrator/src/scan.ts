// packages/orchestrator/src/scan.ts
// 共享录像扫描函数：被 LocalTransport 和 _inventory CLI 子命令复用。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  epochFromZonedParts, isAtomicTempName, isVideoFileName, processTimeZone,
  segmentIndexOf, sessionBaseOf, stampedSessionBaseOf,
} from "@drec/core";
import { groupSessionsInDir, isSplitPartName } from "@drec/post-process";
import type { ActiveRecordingRoom, NodeRecording, NodeRollingProgress, NodeRollingSession } from "./transport.js";
import { readGaps, totalGapSecOf } from "./gaps.js";

interface GapInterval { startMs: number; endMs: number }

/**
 * 统计一份弹幕 xml 的条目数(弹幕 `<d>` + 礼物 `<gift>` + 入场 `<member>`)。
 * **仅表头的空 xml**(WS 被风控/未连上,只有 metadata + 样式表)返回 0 —— 这正是选优要区分的
 * 「有文件但没弹幕」。样式表里不含 `<d `/`<gift `/`<member `(实测表头段 0 命中),故纯计数安全。
 * 读文件失败(缺失/权限)→ 0(视为无弹幕,不影响选优其余维度)。
 */
function countDanmuEntries(xmlPath: string): number {
  let text: string;
  try {
    text = readFileSync(xmlPath, "utf-8");
  } catch {
    return 0;
  }
  const count = (re: RegExp): number => (text.match(re) ?? []).length;
  return count(/<d /g) + count(/<gift /g) + count(/<member /g);
}

/**
 * 读会话 sidecar,取 roomSlug + platform + totalGapSec。
 * 新格式:`{base}.session.json`(身份+缺口合一,录制端 manager 写)。
 * 旧格式回落:`{base}.meta.json`(身份)+ `{base}.gaps.json`(缺口)—— 兼容历史录像。
 * 全缺失/损坏 → totalGapSec=0、roomSlug/platform=undefined。
 */
function readSession(dir: string, base: string): {
  roomSlug?: string; platform?: string; totalGapSec: number; title?: string;
  startMs?: number;
} {
  try {
    const d = JSON.parse(readFileSync(join(dir, `${base}.session.json`), "utf-8")) as
      { roomSlug?: string; platform?: string; totalGapSec?: number; gaps?: GapInterval[]; title?: string;
        startMs?: number };
    return {
      roomSlug: d.roomSlug || undefined,
      platform: d.platform || undefined,
      totalGapSec: d.totalGapSec ?? (d.gaps ? totalGapSecOf(d.gaps) : 0),
      title: d.title || undefined,
      // Authoritative absolute start (issue #87). Require a millisecond-scale epoch so a
      // zero / seconds-scale / string / malformed value falls back to the legacy filename
      // parse below instead of producing a 1970 streamKey.
      startMs: typeof d.startMs === "number" && d.startMs >= 1e12 ? d.startMs : undefined,
    };
  } catch { /* 无 session.json → 回落旧 meta+gaps */ }
  let roomSlug: string | undefined, platform: string | undefined;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${base}.meta.json`), "utf-8")) as { roomSlug?: string; platform?: string };
    roomSlug = m.roomSlug || undefined; platform = m.platform || undefined;
  } catch { /* 无 meta */ }
  const g = readGaps(join(dir, `${base}.gaps.json`));
  return { roomSlug: roomSlug ?? g?.roomSlug, platform, totalGapSec: g?.totalGapSec ?? 0 };
}

/**
 * 读边录边传(T-33)结果 sidecar `{base}.rolling.json`(录制端写)。
 * 存在且带 bv = 该会话已由录制节点自己建稿 → master **不得重复建稿**(否则重复投稿)。
 * 缺失/损坏 → undefined(老录像/未启用;不抛)。
 */
function readRolling(dir: string, base: string): NodeRollingProgress | undefined {
  try {
    const d = JSON.parse(readFileSync(join(dir, `${base}.rolling.json`), "utf-8")) as
      { bv?: string; confirmed?: unknown; ambiguous?: unknown; uploading?: { index?: unknown; kind?: unknown } | null };
    const u = d.uploading;
    // 意图标记原样透传给主控(主控据此区分「建稿中被杀」);形状不合法 → 当作无(不抛)。
    const uploading: NodeRollingProgress["uploading"] = u && typeof u.index === "number" && (u.kind === "create" || u.kind === "append")
      ? { index: u.index, kind: u.kind as "create" | "append" }
      : undefined;
    return {
      uploading,
      bv: typeof d.bv === "string" && d.bv ? d.bv : undefined,
      confirmed: Array.isArray(d.confirmed) ? d.confirmed.filter((n): n is number => typeof n === "number") : undefined,
      ambiguous: Array.isArray(d.ambiguous) ? d.ambiguous.filter((n): n is number => typeof n === "number") : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * 扫边录边传会话的**实时进度**(F1,只读)。
 * 纳入:①该房间此刻在录,且是它最新的一个会话;②任何会话只要有「正在传 / 结果未知」的未决项(收播后仍需关注)。
 * 已收口的旧会话不纳入。不读 .ts、不 ffprobe,只读 sidecar,可以每 5 秒调一次。
 */
export function scanRollingSessions(recordingsDir: string, active: readonly ActiveRecordingRoom[]): NodeRollingSession[] {
  type Cand = NodeRollingSession & { startMs: number };
  const cands: Cand[] = [];
  let anchors: string[] = [];
  try {
    anchors = readdirSync(recordingsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
  for (const anchor of anchors) {
    const dir = join(recordingsDir, anchor);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = /^(.+)\.rolling\.json$/.exec(f);
      if (!m) continue;
      const base = m[1]!;
      try {
        const d = JSON.parse(readFileSync(join(dir, f), "utf-8")) as {
          bv?: unknown; segments?: unknown; confirmed?: unknown; ambiguous?: unknown; startMs?: unknown;
          uploading?: { index?: unknown; kind?: unknown } | null;
        };
        const sess = readSession(dir, base);
        if (!sess.roomSlug) continue;
        const platform = sess.platform ?? "douyin";
        const num = (a: unknown): number => (Array.isArray(a) ? a.filter((n) => typeof n === "number").length : 0);
        // 未确认分段仍压在盘上的字节:sidecar 登记的分段里,序号不在 confirmed 且文件还在的那些。
        const confirmedIdx = new Set(Array.isArray(d.confirmed) ? d.confirmed.filter((n): n is number => typeof n === "number") : []);
        let lockedBytes = 0;
        if (Array.isArray(d.segments)) {
          for (const sg of d.segments as Array<{ index?: unknown; path?: unknown }>) {
            if (typeof sg?.index !== "number" || typeof sg.path !== "string" || confirmedIdx.has(sg.index)) continue;
            try { lockedBytes += statSync(sg.path).size; } catch { /* 已删/不存在:不占盘 */ }
          }
        }
        const u = d.uploading;
        const uploading = u && typeof u.index === "number" && (u.kind === "create" || u.kind === "append")
          ? { index: u.index, kind: u.kind as "create" | "append" } : undefined;
        cands.push({
          platform, roomSlug: sess.roomSlug, sessionBase: base,
          bv: typeof d.bv === "string" && d.bv ? d.bv : undefined,
          confirmed: num(d.confirmed), total: Array.isArray(d.segments) ? d.segments.length : 0,
          ambiguous: num(d.ambiguous), uploading, lockedBytes,
          recording: active.some((r) => r.platform === platform && r.roomSlug === sess.roomSlug),
          startMs: typeof d.startMs === "number" ? d.startMs : 0,
        });
      } catch { /* 损坏的 sidecar 跳过,绝不抛 */ }
    }
  }
  // 在录的房间只认其最新会话(startMs 最大),避免把同房间昨天没清的旧会话也标成「在录」。
  const latest = new Map<string, number>();
  for (const c of cands) {
    if (!c.recording) continue;
    const k = `${c.platform}:${c.roomSlug}`;
    latest.set(k, Math.max(latest.get(k) ?? 0, c.startMs));
  }
  return cands
    .filter((c) => {
      const pending = c.ambiguous > 0 || !!c.uploading;
      const isLatestRecording = c.recording && c.startMs === latest.get(`${c.platform}:${c.roomSlug}`);
      return pending || isLatestRecording;
    })
    .map(({ startMs: _s, ...rest }) => rest);
}

export type FfprobeAdapter = (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;

/**
 * 从会话 base(`{name}_{YYYY-MM-DD}_{HH}-{mm}-{ss}`)解析录制起点 epoch ms。
 *
 * 为什么需要:边录边传(T-33)的会话可能**一个 .ts 都不剩**(确认后全删),此时没有任何
 * ffprobe 结果可推 startMs —— 若留 0,聚类会算出 `1970-01-01` 的 streamKey,收口写错场。
 * 会话 base 尾部的 `YYYY-MM-DD_HH-mm-ss` 就是录制起点(设置时区墙钟),用它兜底。
 * 解析不出 → 0(调用方按旧行为处理)。
 */
function startMsFromSessionBase(base: string): number {
  const m = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(base);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m;
  // 墙钟按设置时区还原(与 record-engine `stamp` 同口径),不看宿主机本地时区(issue #155)。
  return epochFromZonedParts(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), processTimeZone());
}

/**
 * 扫描 recordingsDir 下所有主播子目录，聚合会话分段，返回 NodeRecording[]。
 *
 * @param recordingsDir  录像根目录（每个子目录 = 主播名）
 * @param taskRooms      anchorName → roomSlug 映射（未命中时 fallback 用目录名）
 * @param ffprobe        文件级时长/起止获取器（可注入 fake）
 */
export async function scanRecordings(
  recordingsDir: string,
  taskRooms: Record<string, string>,
  ffprobe: FfprobeAdapter,
): Promise<NodeRecording[]> {
  const recordings: NodeRecording[] = [];
  let anchors: string[] = [];
  try {
    anchors = readdirSync(recordingsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { anchors = []; }

  for (const anchor of anchors) {
    const dir = join(recordingsDir, anchor);
    const files = readdirSync(dir);
    // 节点侧原地替换(issue #137)后的 mp4/mkv 分段(含无段号单文件)靠 session.json 的 nodeFormat 识别;
    // 只在**录制目录**这里传 —— stage / 合并模式不传,分 P 产物与合并产物不会被当成源。
    const groups = groupSessionsInDir(dir, files);
    // A converted segment whose session sidecar was lost is invisible to `groupSessionsInDir`
    // (without `nodeFormat` it cannot tell a source segment from a merge artifact). Surface only
    // unambiguously source-shaped files: timestamped base + numeric segment index. The later
    // stage re-grouping then reports them as unclaimed and turns the session manual (issue #176).
    const claimed = new Set(Object.values(groups).flatMap((g) => g.ts));
    for (const f of files) {
      if (claimed.has(f) || isAtomicTempName(f) || !isVideoFileName(f)) continue;
      if (/\.(ts|flv)$/i.test(f)) continue;
      if (segmentIndexOf(f) < 0 || !stampedSessionBaseOf(f)) continue;
      // Split products (`{stem}_part0.mp4`) carry a stamped prefix but are upload parts, not source.
      if (isSplitPartName(f)) continue;
      const base = sessionBaseOf(f);
      groups[base] ??= { ts: [], xml: null, segmentXmls: [] };
      groups[base].ts.push(f);
      claimed.add(f);
    }
    // 边录边传(T-33):已确认段被节点删空后,该会话在 groupSessions 里**没有条目**
    // (只有 .xml + .rolling.json 存活)。补出来,否则 master 看不到「已建稿」事实 → 漏收口。
    for (const f of files) {
      const m = /^(.+)\.rolling\.json$/.exec(f);
      if (m && !groups[m[1]]) groups[m[1]] = { ts: [], xml: null, segmentXmls: [] };
    }
    for (const [base, g] of Object.entries(groups)) {
      const rolling = readRolling(dir, base);
      // 边录边传(T-33):已确认的段被录制节点删掉后,该会话可能 **一个 .ts 都不剩**。
      // 但它是**已完成上传**的场(rolling.bv 存在)—— 必须照样出现在清单里,否则 master 收不到
      // 「已建稿」事实,reconciler 会把它当没有录像而漏掉收口。故:无 ts 但 rolling.bv 存在 → 仍产出。
      // 同理:无 ts、无 bv,但留有建稿意图/不确定段 → 也要产出,主控才能转人工而不是装作没这场。
      if (!g.ts.length && !rolling?.bv && !rolling?.uploading && !rolling?.ambiguous?.length) continue;
      let durationSec = 0, startMs = Infinity, endMs = 0;
      let totalBytes = 0, bytesKnown = true;
      for (const f of g.ts) {
        try { totalBytes += statSync(join(dir, f)).size; } catch { bytesKnown = false; }
        const p = await ffprobe(join(dir, f));
        durationSec += p.durationSec;
        startMs = Math.min(startMs, p.startMs);
        endMs = Math.max(endMs, p.endMs);
      }
      const sess = readSession(dir, base);
      // No-ts session (rolling upload deleted every segment): prefer the absolute start
      // recorded in the sidecar (issue #87) over reverse-parsing the filename in this
      // process's local timezone (a UTC reader would land on the wrong day). Sessions
      // that still have ts keep the ffprobe result; only this fallback changes.
      if (startMs === Infinity) {
        startMs = sess.startMs ?? startMsFromSessionBase(base);
        // No segments left → the span is unknown; keep the pre-change zero span. We do NOT
        // read a sidecar endMs (no recorder writes a trustworthy one; a stop-time value would
        // inflate coverage and could merge adjacent broadcasts).
        endMs = startMs;
      }
      // 弹幕源 .xml 是**可选**产物:缺失(异常中断/历史录像)时不能把不存在的路径交给 pull
      // (本地 copyFileSync 会 ENOENT、rsync 会 rc≠0,整场后处理直接失败)。
      const xmlAbs = join(dir, `${base}.xml`);
      const hasXml = existsSync(xmlAbs);
      // 会话标识边车随 pull 进 stage(声明节点侧已转换的容器,issue #143);缺失(老录像)不填,pull 不带它。
      const sessionJsonAbs = join(dir, `${base}.session.json`);
      const hasSessionJson = existsSync(sessionJsonAbs);
      recordings.push({
        // slug = 房间号(web_rid)唯一 ID。优先级:session.json/旧 sidecar(随录像走、跨节点一致)
        // > taskRooms[主播名] > 目录名(后两者不可靠回退)。
        roomSlug: sess.roomSlug ?? taskRooms[anchor] ?? anchor,
        // platform 来自 sidecar(新录像必有);旧录像/缺省 → douyin(历史只有抖音)。
        platform: sess.platform ?? "douyin",
        sessionBase: base,
        tsFiles: g.ts.map((f) => join(dir, f)),
        xmlPath: hasXml ? xmlAbs : undefined,
        ...(hasSessionJson ? { sessionJsonPath: sessionJsonAbs } : {}),
        // 弹幕条目数(0 = 仅表头的空 xml,或文件缺失)。选优据此避免选中「视频全但弹幕空」的节点。
        danmuCount: hasXml ? countDanmuEntries(xmlAbs) : 0,
        durationSec,
        // 统计不全(某段 stat 失败)→ 不上报,调用方按未知处理,不拿偏小的数估超时。
        ...(g.ts.length && bytesKnown ? { totalBytes } : {}),
        startMs: startMs === Infinity ? 0 : startMs,
        endMs,
        totalGapSec: sess.totalGapSec,
        title: sess.title,
        rolling,
      });
    }
  }
  return recordings;
}
