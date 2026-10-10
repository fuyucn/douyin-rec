/**
 * node-pipeline.ts — 节点侧上传(experimental,见 plans/027)。
 *
 * 现状:master 收播后 `select → pull(rsync 回传录像) → merge → burn → upload`,后处理集中 master。
 * 本模块是 **feature flag(`pipeline.steps.nodeSideUpload`)开启时**的另一条路:
 * 该房间**不烧录**时,由 winner 节点本地 remux → biliup 上传,master 只收 BV 号,
 * **省掉整场录像 rsync 回传**(实测 pull 是主要耗时:165s~4198s)。
 *
 * 为什么限制「不烧录」:burn 是全量重编码,需 11 核 + 中文字体;弱节点(2 vCPU / ~77% steal)
 * 实测仅 0.38x 实时,烧不动。故开烧录的房间一律回落 master 集中处理。
 *
 * 本模块在**节点**上执行(`_node-pipeline` 隐藏子命令)。复用:
 *   - @drec/post-process 的 remuxSegment / mergeSession / ffprobeDuration
 *   - @drec/app 的 uploadPlain / appendGroup(biliup)
 *   - core 的 title-template(与 master 同源的产物命名/稿件标题)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { biliAccountKey, biliAccountKeyFromCookiesJson, formatBiliTitle, formatPartTitle, openUploadLimitStore, resolveOutputStem, sanitizeStreamKey, UploadGate, type NodePipelineResult, type NodePipelineSpec, type UploadGateStore } from "@drec/core";
import { ffprobeDuration, mergeSession, remuxSegment } from "@drec/post-process";
import { appendGroup, uploadPlain } from "./upload/biliup.js";
import { rootBiliupCookies, rootDbPath } from "./paths.js";

/** 会话 base(与 orchestrator/session-plan 同规则:剥 -PART###/_PART###/_### 后缀)。 */
function sessionBaseOfFile(name: string): string | undefined {
  const m = /^(.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-PART\d+|_PART\d+|_\d{3,})?\.(?:ts|flv|xml|mp4)$/i.exec(name);
  return m?.[1];
}

/**
 * 节点侧上传的**限流闸门**(030 T19,T-18 房间不上传风暴)。
 *
 * 为什么必须有:节点侧上传**绕过** master 的 ResourcePool(没有上传链、没有冷却、没有滑动窗口),
 * 历史上等于「不限速投稿」→ 与 master 侧互不感知地猛传 → 反复撞 601/21566 风控。
 * 现在节点侧走 **core 的 UploadGate(与 master 同一判定实现)**,并用**同一个账号键**
 * (`bilibili:<DedeUserID>`,从本机 biliup cookies 解析)—— 同账号在 master 与节点上是**同一个限流桶**;
 * 状态落在**节点本地** `<dataRoot>/db/douyin-rec.db` 的 `upload_limits` 表(跨重启保留)。
 *
 * 诚实边界:master 与节点是两台机器,**不共享文件系统** → 各持久化各的;跨节点的**即时**互斥
 * 需要 master→节点下发冷却(后续里程碑)。本任务保证:两侧都不再无限速、各自重启不丢冷却、
 * 同一账号的判定口径完全一致 —— 不再出现「一边冷却、一边猛传」的长期失衡。
 */
export interface NodeUploadGateOpts {
  /** 限流状态存储;缺省 = 节点本地 db 的 upload_limits 表。 */
  store?: UploadGateStore;
  accountKey?: string;
  rateLimit?: number;
  windowMs?: number;
  cooldownMs?: number;
  warn?: (msg: string) => void;
}

/** 从本机 biliup cookies.json 解析限流账号键(唯一真理 = core 的 biliAccountKey*;解析不出 → unknown 桶)。 */
export function resolveUploadAccountKey(cookiesPath?: string): string {
  const p = cookiesPath ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
  try {
    return biliAccountKeyFromCookiesJson(readFileSync(p, "utf-8"));
  } catch {
    return biliAccountKey(null);
  }
}

/** 装配节点侧 UploadGate;store 缺省打开 `<dataRoot>/db/douyin-rec.db`。 */
export function openNodeUploadGate(opts: NodeUploadGateOpts = {}): UploadGate {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  return new UploadGate({
    store: opts.store ?? openUploadLimitStore(rootDbPath(), { log: warn }),
    rateLimit: opts.rateLimit ?? 5,
    windowMs: opts.windowMs ?? 600_000,
    cooldownMs: opts.cooldownMs ?? 1_800_000,
    warn,
  });
}

/** 节点侧上传的一个「分 P」产物(与 master 分段模式同义:单段 remux 或若干段合并)。 */
interface NodePart {
  /** 待上传 plain mp4。 */
  plain: string;
  /** 构成该分 P 的源文件(清理用)。 */
  sources: string[];
}

/**
 * 按 segmentGroupSec 把源段聚组成分 P(与 master 分段模式同规则:累计接近目标时长即切组,
 * 允许超出至多 20%;<=0 = 逐段一个分 P)。
 */
async function planGroups(
  tsFiles: string[],
  groupSec: number,
  durationOf: (f: string) => Promise<number>,
): Promise<string[][]> {
  if (groupSec <= 0) return tsFiles.map((f) => [f]);
  const groups: string[][] = [];
  let cur: string[] = [];
  let acc = 0;
  for (const f of tsFiles) {
    const d = await durationOf(f).catch(() => 0);
    cur.push(f);
    acc += d;
    if (acc >= groupSec * 0.8) {
      groups.push(cur);
      cur = [];
      acc = 0;
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/** 逐段 remux / 组内合并 → 每个分 P 的 plain mp4(落在 stageSub)。 */
async function produceParts(
  spec: NodePipelineSpec,
  stageSub: string,
  log: (m: string) => void,
): Promise<NodePart[]> {
  mkdirSync(stageSub, { recursive: true });
  const groupSec = spec.mergeSegments ? (spec.segmentGroupSec ?? 0) : 0;
  const groups = await planGroups(spec.tsFiles, groupSec, (f) => ffprobeDuration(f));

  const parts: NodePart[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const out = path.join(stageSub, `part_${String(i + 1).padStart(3, "0")}.mp4`);
    if (group.length === 1) {
      await remuxSegment(group[0], out);
    } else {
      await mergeSession(group, out);
    }
    parts.push({ plain: out, sources: group });
    log(`分 P ${i + 1}/${groups.length}: ${group.length} 段 → ${path.basename(out)}`);
  }
  return parts;
}

/** 由源文件推导输出 stem / 稿件标题(与 master pipeline 同源,保证命名一致)。 */
function deriveTitles(spec: NodePipelineSpec, log: (m: string) => void): { stem: string; title: string; partTitle?: (i: number, n: number) => string | null } {
  const base = sessionBaseOfFile(path.basename(spec.tsFiles[0] ?? "")) ?? sanitizeStreamKey(spec.streamKey);
  // startMs:用首段文件的 mtime 兜底(节点侧无 inventory 的精确 startMs;命名用日期即可)。
  const startMs = Date.now();
  const stem = resolveOutputStem({
    template: spec.uploadMeta.titleTemplate,
    sessionBase: base,
    startMs,
    timeZone: spec.timeZone,
  });
  const subTpl = (spec.uploadMeta.submissionTitleTemplate ?? "").trim();
  const ctx = { sessionBase: base, startMs, timeZone: spec.timeZone };
  const title = subTpl ? formatBiliTitle(subTpl, ctx) : stem;
  const pt = spec.uploadMeta.partTitleTemplate;
  const partTitle = pt
    ? (i: number, n: number): string | null => formatPartTitle(pt, { ...ctx, partIndex: i, partTotal: n }, "plain")
    : undefined;
  log(`产物 stem: ${stem}${title !== stem ? ` | 稿件标题: ${title}` : ""}`);
  return { stem, title, partTitle };
}

/**
 * 节点侧执行:remux(可选聚组)→ 可选上传 → 返回 BV。
 * 幂等:上传沿用「P1 建稿 → 逐组 append」,与 master 侧同款(失败可安全重试,不会重复建稿)。
 */
export async function runNodeSidePipeline(
  spec: NodePipelineSpec,
  log: (m: string) => void = () => {},
  /** 限流闸门;缺省按 {@link openNodeUploadGate}(节点本地库 + 本机账号键)惰性装配。 */
  gate?: UploadGate,
): Promise<NodePipelineResult> {
  if (spec.tsFiles.length === 0) return { ok: false, error: "无源文件(tsFiles 为空)" };
  const missing = spec.tsFiles.filter((f) => !existsSync(f));
  if (missing.length > 0) return { ok: false, error: `源文件不存在: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}` };

  const stageSub = path.join(spec.stageDir, sanitizeStreamKey(spec.streamKey));
  log(`=== 节点侧管线 start ${spec.streamKey} 段数=${spec.tsFiles.length} mode=${spec.uploadMode} ===`);

  const { title, partTitle } = deriveTitles(spec, log);
  const parts = await produceParts(spec, stageSub, log);
  const products = parts.map((p) => p.plain);

  if (spec.uploadMode !== "upload") {
    log(`stage 模式:产物留节点 ${stageSub}`);
    return { ok: true, products };
  }

  // 上传:节点本地 cookies 优先,master 下发的兜底。
  const cookiesPath = process.env.BILIUP_COOKIE ?? rootBiliupCookies();
  const cookies = existsSync(cookiesPath) ? "" : (spec.cookies ?? "");
  const publicUpload = !spec.uploadPrivate;
  const meta = { cookies, tag: spec.uploadMeta.tag, tid: spec.uploadMeta.tid, desc: spec.uploadMeta.desc, public: publicUpload };

  const files = parts.map((p) => p.plain);
  log(`上传 ${files.length} 个分 P → B站`);
  // 限流:先过 core UploadGate(冷却 + 滑动窗口 + 占额),命中 601/21566 自动记冷却(跨重启保留)。
  // accountKey = 本机 biliup 账号 → 与 master 侧同一个限流桶(键算法唯一真理在 core)。
  const uploadGate = gate ?? openNodeUploadGate({ warn: log });
  const accountKey = resolveUploadAccountKey(cookiesPath);
  const bv = await uploadGate.run(accountKey, () =>
    uploadPlain({
      plain: {
        ...meta,
        // 单分 P 用 video;多分 P 一次多文件建稿(videos)。
        ...(files.length === 1 ? { video: files[0] } : { videos: files }),
        title,
      },
    }),
  );
  log(`建稿成功 BV=${bv}`);

  // 分 P 标题(可选):master 侧为每个分 P 单独 append 时设名;此处一次性多文件建稿,
  // 分 P 名由 biliup 用文件名派生 → 与 master 行为一致(未配 partTitleTemplate 时)。
  if (partTitle) log(`注:节点侧一次性建稿,分 P 标题取文件名(partTitleTemplate 在节点侧分支暂不生效)`);
  void partTitle;

  // 清理源文件(可选,与 master cleanup.sourceAfterDone 同义)。
  if (spec.cleanSourceAfterDone) {
    const { rmSync } = await import("node:fs");
    const all = [...spec.tsFiles, ...(spec.xmlPath ? [spec.xmlPath] : [])];
    for (const f of all) { try { rmSync(f, { force: true }); } catch { /* 忽略 */ } }
    log(`已清理节点源文件 ${all.length} 个`);
  }
  return { ok: true, bv, products };
}

/** 节点侧上传能力探测:节点上是否有 biliup + B站 cookie + 中文字体 + 磁盘剩余。 */
export async function probeNodeCapabilities(dataRoot: string): Promise<{
  biliup: boolean; cookies: boolean; diskFreeGB: number; cjkFonts: boolean;
}> {
  const { spawnSync } = await import("node:child_process");
  const hasBiliup = spawnSync("sh", ["-c", "command -v biliup"], { stdio: "ignore" }).status === 0;
  const cookiesPath = process.env.BILIUP_COOKIE ?? path.join(dataRoot, "config", "biliup", "cookies.json");
  const hasCookies = existsSync(cookiesPath);
  let diskFreeGB = 0;
  try {
    const { statfs } = await import("node:fs/promises");
    const st = await statfs(dataRoot);
    diskFreeGB = (Number(st.bavail) * Number(st.bsize)) / 1e9;
  } catch { /* 目录不存在等 → 0 */ }
  // 中文字体(烧录用;节点侧分支不烧,仅诊断展示)。fc-list 缺失 = 无。
  const cjkFonts = spawnSync("sh", ["-c", "fc-list 2>/dev/null | grep -qi 'noto sans cjk'"], { stdio: "ignore" }).status === 0;
  return { biliup: hasBiliup, cookies: hasCookies, diskFreeGB, cjkFonts };
}

/** 列出 stage 目录下的产物(stage 模式调试/展示用)。 */
export function listNodeProducts(stageSub: string): string[] {
  try { return readdirSync(stageSub).filter((f) => f.endsWith(".mp4")).map((f) => path.join(stageSub, f)); } catch { return []; }
}
