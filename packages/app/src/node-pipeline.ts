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
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  biliAccountKey, biliAccountKeyFromCookiesJson, formatBiliTitle, formatPartTitle, isAppendAmbiguous,
  isUploadRateLimited, openUploadLimitStore, partTitleToFilename, resolveOutputStem, sanitizeStreamKey,
  UploadGate, type NodePipelineResult, type NodePipelineResultFile, type NodePipelineSpec, type UploadGateStore,
} from "@drec/core";
import { ffprobeDuration, mergeSession, planSegmentGroups, remuxSegment } from "@drec/post-process";
import { appendGroup, uploadPlain } from "./upload/biliup.js";
import { rootBiliupCookies, rootDbPath, rootStageDir } from "./paths.js";

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

/** 上传别名集中放这里(stage 内子目录),上传完成整体删除。与 orchestrator 的常量同名同义。 */
const UPLOAD_ALIAS_DIR = ".upload";

/**
 * 节点侧**落盘结果文件名**(与 master 回读约定一致,单一真理在此)。
 *
 * 放在 stageSub 内(`<root>/stage/<sanitizeStreamKey>/.drec-node-result.json`),原因:
 *   - master 已经知道该路径(它自己按 `sanitizeStreamKey(streamKey)` 拼),无需新协议;
 *   - `nodeStageCleanupTargets` **不会**删它(只匹配 mp4/.work/.upload/.xml/.ass)⇒ 清完 stage 后
 *     文件仍在 ⇒ master 回读「上传其实成功了」时,源文件的删除判定依然可用。
 */
const NODE_RESULT_FILE = ".drec-node-result.json";

/** 节点侧结果文件路径(stage 子目录内)。 */
export function nodeResultPath(stageSub: string): string {
  return path.join(stageSub, NODE_RESULT_FILE);
}

/**
 * 写节点侧结果文件(落盘即权威:ssh 断线也不丢)。写失败**不抛**——它只是给 master 回读用,
 * 不该让一次正常的 remux/上传因为写诊断文件失败而中断;但要**留痕**(master 回读不到会按失败处理)。
 */
export function writeNodeResult(stageSub: string, r: Omit<NodePipelineResultFile, "atMs">, log: (m: string) => void): void {
  try {
    mkdirSync(stageSub, { recursive: true });
    writeFileSync(nodeResultPath(stageSub), JSON.stringify({ ...r, atMs: Date.now() }) + "\n");
  } catch (e) {
    log(`⚠️ 写节点结果文件失败(${(e as Error)?.message ?? e}):master 若 ssh 断线将无法回读本次结果`);
  }
}

/** 读节点侧结果文件(不存在/损坏 → null)。master 侧回读与节点侧自查共用。 */
export function readNodeResult(stageSub: string): NodePipelineResultFile | null {
  try {
    const raw = readFileSync(nodeResultPath(stageSub), "utf-8");
    const parsed = JSON.parse(raw) as Partial<NodePipelineResultFile>;
    const phase = parsed.phase;
    if (phase !== "uploading" && phase !== "done" && phase !== "failed") return null;
    return {
      phase,
      ok: parsed.ok === true,
      bv: typeof parsed.bv === "string" ? parsed.bv : undefined,
      products: Array.isArray(parsed.products) ? parsed.products : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      atMs: typeof parsed.atMs === "number" ? parsed.atMs : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 按分 P 标题给产物建一个可上传的**别名文件**(硬链接),返回传给 biliup 的路径。
 *
 * 为什么节点侧也要做:master 分段模式靠「文件名 = 分 P 标题」让 biliup 派生分 P 名
 * (`uploader/line.rs` 在 title 为空时用 `file_stem()`),节点侧若跳过这步,`partTitleTemplate`
 * 就形同虚设(线上实测:分 P 名变成 `114275050882_2026-10-11_09-50-00_001`)。
 *
 * 硬链接零拷贝;不可用(跨设备/文件系统不支持)时回落复制。失败不阻断上传(回落原名)。
 * 注意:app(L4)不能 import orchestrator(L4.5)的 `prepareUploadAlias`,故此处按同一语义复刻。
 */
export function prepareNodeUploadAlias(stageSub: string, desiredStem: string | null, canonical: string): string {
  if (!desiredStem) return canonical;
  const ext = canonical.slice(canonical.lastIndexOf("."));
  const dir = path.join(stageSub, UPLOAD_ALIAS_DIR);
  const dst = path.join(dir, `${desiredStem}${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(dst)) rmSync(dst, { force: true }); // 续跑:旧别名先删,保证指向最新产物
    try {
      linkSync(canonical, dst);
    } catch {
      copyFileSync(canonical, dst);
    }
    return dst;
  } catch {
    return canonical;
  }
}

/** 渲染第 idx 个分 P 的标题并转成文件名 stem;撞名时补 `-P{idx}` 兜底(与 master 同规则)。 */
function aliasStemFor(
  partTitle: ((i: number, n: number) => string | null) | undefined,
  used: Set<string>,
  idx: number,
  total: number,
  log: (m: string) => void,
): string | null {
  const title = partTitle?.(idx, total) ?? null;
  if (!title) return null;
  const base = partTitleToFilename(title);
  if (!base) return null;
  let stem = base;
  for (let n = 0; used.has(stem); n++) stem = `${base}-P${idx}${n > 0 ? `-${n}` : ""}`;
  if (stem !== base) log(`分P标题「${base}」重名 → 改用「${stem}」(模板需含 {part} 才能区分多个分P)`);
  used.add(stem);
  return stem;
}

/**
 * 限流闸门装订点:每次提交都重新取配额(命中 601 时 `gate.run` 内部会记冷却 → 下次提交先等冷却)。
 * 与 master 的 `runUpload`(ResourcePool.withUpload)位置对等 —— 覆盖**每一次**提交,不是整个批次。
 */
function withGate<T>(gate: UploadGate, accountKey: string, fn: () => Promise<T>): Promise<T> {
  return gate.run(accountKey, fn);
}

/**
 * 有限次重试 + 指数退避(语义与 orchestrator/retry.ts 一致;app 不能 import orchestrator,故本地复刻)。
 * 只用于**可安全重试**的提交:失败原因不确定的 append 由 `shouldRetry` 挡掉,避免重复建 P。
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries: number; backoffMs: number; shouldRetry: (e: unknown) => boolean; sleep?: (ms: number) => Promise<void>; onRetry?: (n: number, e: unknown) => void },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= Math.max(1, opts.tries); attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (attempt >= opts.tries || !opts.shouldRetry(e)) break;
      opts.onRetry?.(attempt, e);
      await sleep(opts.backoffMs * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/** 节点侧上传的一个「分 P」产物(与 master 分段模式同义:单段 remux 或若干段合并)。 */
interface NodePart {
  /** 待上传 plain mp4(stage 内规范名 `{stem}_{NNN}.mp4`)。 */
  plain: string;
  /** 构成该分 P 的源文件(清理/诊断用)。 */
  sources: string[];
  /** 该分 P 的时长(秒;聚组与碎片过滤用)。 */
  durSec: number;
}

/**
 * 按会话边界切分聚组计划(与 master `segment-pipeline.ts` 的 `splitGroupsBySession` 同实现):
 * **一个分 P 只能属于一个会话** —— 每个会话一份 xml,时间轴各自从 0 起;
 * 跨会话聚组会把两个会话的弹幕窗口并成一个却只用其中一个 xml → 窗口错位/弹幕丢失。
 */
export function splitGroupsBySession(groups: number[][], xmlPathOf: (i: number) => string): number[][] {
  const out: number[][] = [];
  for (const g of groups) {
    let cur: number[] = [];
    let curXml = "";
    for (const k of g) {
      const xml = xmlPathOf(k) ?? "";
      if (cur.length > 0 && xml !== curXml) {
        out.push(cur);
        cur = [];
      }
      cur.push(k);
      curXml = xml;
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}

/**
 * 按 segmentGroupSec 把源段聚组成分 P。
 *
 * **与 master 分段模式同规则**:直接调 `@drec/post-process` 的 `planSegmentGroups`
 * (唯一真理源 —— 目标时长的 `maxRatio=1.2` 上限)。曾经这里另写了一份「累计 ≥ 0.8×目标就切」
 * 的近似算法 → 同一场在节点侧与 master 侧切出**不同的分 P 数/长度**,用户看到的稿件形态就变了;
 * 「同一个判定在两个地方各写一份」是本仓库明令禁止的。
 * 之后再按会话切分(见 `splitGroupsBySession`)。`groupSec<=0` = 逐段一个分 P。
 */
export function planGroups(
  tsFiles: string[],
  groupSec: number,
  durations: number[],
  xmlPathOf: (i: number) => string,
): string[][] {
  const planned = planSegmentGroups(durations, groupSec);
  return splitGroupsBySession(planned, xmlPathOf).map((g) => g.map((i) => tsFiles[i]!));
}

/** 同 {@link planGroups} 的下标版:`produceParts` 需要下标取时长(避免 `indexOf` 反查)。 */
function planGroupIndices(groupSec: number, durations: number[], xmlPathOf: (i: number) => string): number[][] {
  return splitGroupsBySession(planSegmentGroups(durations, groupSec), xmlPathOf);
}

/**
 * 逐段 remux / 组内合并 → 每个分 P 的 plain mp4(落在 stageSub)。
 *
 * 命名与 master 分段模式**逐字一致**:`{stem}_{NNN}.mp4` —— 这个名字会直接变成 B 站分 P 的
 * 默认标题,绝不能是 `part_001.mp4` 这种内部名。逐段 remux 中间产物放 `.work/` 子目录。
 * 碎片过滤:mesio `--fix` 切出的 0.2s 级初始化残片不产出(与 master `minSegmentSec` 同规则)。
 */
async function produceParts(
  spec: NodePipelineSpec,
  stageSub: string,
  dateName: string,
  log: (m: string) => void,
): Promise<NodePart[]> {
  mkdirSync(stageSub, { recursive: true });
  const durationOf = async (f: string): Promise<number> => ffprobeDuration(f).catch(() => 0);
  const durations: number[] = [];
  for (const f of spec.tsFiles) durations.push(await durationOf(f));
  // 段 → 所属会话 xml(与会话 base 同名的兄弟文件;节点上该会话无 xml 则空串)。
  const xmlOf = (i: number): string => {
    const f = spec.tsFiles[i];
    if (!f) return "";
    const base = sessionBaseOfFile(path.basename(f));
    if (!base) return "";
    const xml = path.join(path.dirname(f), `${base}.xml`);
    return existsSync(xml) ? xml : "";
  };

  const groupSec = spec.mergeSegments ? (spec.segmentGroupSec ?? 0) : 0;
  const groups = planGroupIndices(groupSec, durations, xmlOf);

  const minSegSec = spec.minSegmentSec ?? 2;
  const workDir = path.join(stageSub, ".work");
  mkdirSync(workDir, { recursive: true });
  const parts: NodePart[] = [];
  let skippedFragments = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupDur = group.reduce((n, idx) => n + (durations[idx] ?? 0), 0);
    // 整组都是碎片(时长 < minSegmentSec)→ 不产出;有有效段就照常产出(与 master 口径一致)。
    if (minSegSec > 0 && groupDur > 0 && groupDur < minSegSec) {
      skippedFragments++;
      log(`跳过碎片组 ${i}: ${group.map((idx) => path.basename(spec.tsFiles[idx] ?? "")).join(",")}(${groupDur.toFixed(2)}s < ${minSegSec}s)`);
      continue;
    }
    const out = path.join(stageSub, `${dateName}_${String(parts.length).padStart(3, "0")}.mp4`);
    const work = path.join(workDir, `${String(parts.length).padStart(3, "0")}.mp4`);
    const files = group.map((idx) => spec.tsFiles[idx]!);
    if (group.length === 1) {
      if (!existsSync(work)) await remuxSegment(files[0]!, work);
    } else {
      if (!existsSync(work)) await mergeSession(files, work);
    }
    // 中间产物 → 规范上传名(与 master 同款:不能直接把 .work 里的文件当上传物)。
    if (!existsSync(out)) {
      copyFileSync(work, out);
    }
    parts.push({ plain: out, sources: files, durSec: groupDur });
    log(`分 P ${parts.length}: ${group.length} 段(${Math.round(groupDur)}s)→ ${path.basename(out)}`);
  }
  if (skippedFragments > 0) log(`跳过 ${skippedFragments} 个碎片组(<${minSegSec}s)`);
  log(`产出 ${parts.length} 个分 P(目标分P时长 ${groupSec || "未设"}s)`);
  return parts;
}

/**
 * 由 spec 推导输出 stem / 稿件标题 / 分 P 标题(与 master pipeline 同源,保证命名一致)。
 *
 * 三个输入必须由 master 下发,否则渲染会偏:
 *   - `liveTitle`(`{title}`);缺 → 稿件标题里的 `{title}` 渲染成空(如 `…_ 直播回放`);
 *   - `startMs`(开播时刻);缺 → 回落「首个源文件的 mtime」,再缺才用 now()
 *     (否则 `{HH}-{mm}-{ss}` 会渲染成上传时刻);
 *   - `sessionBase`;缺 → 退回从文件名推。
 */
function deriveTitles(spec: NodePipelineSpec, log: (m: string) => void): { stem: string; title: string; partTitle?: (i: number, n: number) => string | null } {
  const base = spec.sessionBase
    || sessionBaseOfFile(path.basename(spec.tsFiles[0] ?? ""))
    || sanitizeStreamKey(spec.streamKey);
  // 开播时刻兜底链:master 下发 → 首段 mtime → now()(最后一级最不可靠,要留痕)。
  let startMs = Number(spec.startMs ?? 0);
  if (!(startMs > 0)) {
    try { startMs = Math.round(statSync(spec.tsFiles[0]!).mtimeMs); } catch { startMs = 0; }
  }
  if (!(startMs > 0)) {
    startMs = Date.now();
    log(`⚠️ 无 startMs(master 未下发且文件 mtime 不可用)→ 回落当前时刻;含 {HH}-{mm}-{ss} 的模板会不准`);
  }
  const liveTitle = spec.liveTitle;
  const stem = resolveOutputStem({
    template: spec.uploadMeta.titleTemplate,
    sessionBase: base,
    startMs,
    timeZone: spec.timeZone,
    liveTitle,
  });
  const subTpl = (spec.uploadMeta.submissionTitleTemplate ?? "").trim();
  const ctx = { sessionBase: base, startMs, timeZone: spec.timeZone, liveTitle };
  // 稿件标题解析顺序与 master 一致:submissionTitleTemplate → 含 {title} 的 titleTemplate → stem。
  const title = subTpl
    ? formatBiliTitle(subTpl, ctx)
    : (spec.uploadMeta.titleTemplate ?? "").includes("{title}") ? formatBiliTitle(spec.uploadMeta.titleTemplate, ctx) : stem;
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

  // ⚠️ **产物目录必须用节点本地的**,不能用 master 传下来的 spec.stageDir。
  // spec.stageDir 来自 master 的 cfg.stageDir(如 /output-data/stage),那是 **master 的路径**;
  // 节点上通常不存在,而且语义也不对 —— 这是「节点本地 remux」,产物当然落节点。
  // 曾经直接 path.join(spec.stageDir, …) → 节点上报 `path argument must be of type string`
  // (master 侧某些配置下 stageDir 为空),整条节点侧上传必然失败(线上实测 3 次全挂转人工)。
  // 现改为:优先 spec.stageDir(仅在它确实存在时,兼容手工/测试场景),否则落节点自己的 stage。
  const stageRoot = spec.stageDir && existsSync(spec.stageDir) ? spec.stageDir : rootStageDir();
  const stageSub = path.join(stageRoot, sanitizeStreamKey(spec.streamKey));
  log(`=== 节点侧管线 start ${spec.streamKey} 段数=${spec.tsFiles.length} mode=${spec.uploadMode} ===`);

  const { stem, title, partTitle } = deriveTitles(spec, log);
  const parts = await produceParts(spec, stageSub, stem, log);
  const products = parts.map((p) => p.plain);

  if (spec.uploadMode !== "upload") {
    log(`stage 模式:产物留节点 ${stageSub}`);
    // stage 模式不上传 ⇒ 无「不确定」窗口,直接落 done(master 回读可确认产物已生成)。
    writeNodeResult(stageSub, { phase: "done", ok: true, products }, log);
    return { ok: true, products };
  }

  // ⚠️ 上传前先落 `uploading` 标记:此后一旦 ssh 回传断开,master 回读会看到它 →
  // 明确「结果不确定」→ 转人工,**绝不自动重传**(重复投稿不可逆)。这是「假失败」修复的另一半。
  writeNodeResult(stageSub, { phase: "uploading", ok: false }, log);

  // 上传:节点本地 cookies.json 优先,master 下发的兜底。
  //
  // ⚠️ `cookies` 是**传给 biliup `-u` 的路径**(不是内容),所以它必须始终是一个**可用路径**。
  // 曾经写成「本地存在 → 空串」(想表达「用本地默认」),结果 `biliup -u "" upload` 直接报
  // `a value is required for '--user-cookie'` → 整条节点侧上传必然失败(线上实测)。
  // 正确:本地有就用本地路径,否则用 master 下发的路径;两者都没有则交给 biliup 自己报错(带原因)。
  const localCookies = process.env.BILIUP_COOKIE ?? rootBiliupCookies();
  const cookies = existsSync(localCookies) ? localCookies : (spec.cookies ?? localCookies);
  const publicUpload = !spec.uploadPrivate;
  const meta = { cookies, tag: spec.uploadMeta.tag, tid: spec.uploadMeta.tid, desc: spec.uploadMeta.desc, public: publicUpload };

  const files = parts.map((p) => p.plain);
  log(`上传 ${files.length} 个分 P → B站`);
  // 限流:先过 core UploadGate(冷却 + 滑动窗口 + 占额),命中 601/21566 自动记冷却(跨重启保留)。
  // accountKey = 本机 biliup 账号 → 与 master 侧同一个限流桶(键算法唯一真理在 core)。
  const uploadGate = gate ?? openNodeUploadGate({ warn: log });
  const accountKey = resolveUploadAccountKey(localCookies);

  // 分 P 标题(可选):与 master 分段模式**同款**——biliup 的分 P 标题取自文件名 stem
  // (`upload`/`append` 都没有「指定分 P 标题」的 CLI 参数),所以给产物建一个文件名 = 标题的
  // **硬链接别名**(`<stageSub>/.upload/`),再把别名路径传给 biliup。未配模板 → 用原名。
  // 同类型多分 P 若模板不含 `{part}` 会算出同名 → 硬链接互相覆盖;撞名时补 `-P{idx}` 兜底。
  const usedAliasStems = new Set<string>();
  const aliasFor = (canonical: string, idx: number, total: number): string =>
    prepareNodeUploadAlias(stageSub, aliasStemFor(partTitle, usedAliasStems, idx, total, log), canonical);

  // P1 建稿 → 其余分 P **逐个 append**(与 master 分段模式逐条对齐,见 segment-pipeline.ts)。
  //
  // 为什么不能「一次多文件建稿」:多文件 `upload` 是 biliup 的**批量建稿**语义,
  // 实测它与逐条 append 的产物形态/命名派生口径不一致,且失败后**无法**判定「建稿成功没」
  // (biliup 对多文件建稿没给可续跑的边界),重试会**重复建稿**。逐条 append 才是 master 侧
  // 长期在跑的形态:P1 建稿成功即有 BV,后续每个 append 可安全重试(见 isAppendAmbiguous)。
  const totalParts = parts.length;
  log(`建稿 P1: ${path.basename(parts[0]!.plain)}(${totalParts} 个分 P 待传)`);
  // 整个上传阶段包一层:任何失败都**先落盘 `failed`** 再抛出 —— master 回读才知道「确实没成」,
  // 从而与「ssh 断了但已成功」区分开。注意 P1 建稿后 append 失败也记 failed(此时已有 BV):
  // master 回读 failed 但带 bv 时按「已建稿、绝不重传」处理(见 node-side-upload.ts)。
  // 空串 = 尚未建稿(与真实 BV 号区分);建稿后 append 失败时把它落进 failed 结果文件。
  let bv = "";
  try {
    bv = await withGate(uploadGate, accountKey, () =>
      withRetry(
        () => uploadPlain({ plain: { ...meta, video: aliasFor(parts[0]!.plain, 1, totalParts), title } }),
        { tries: 3, backoffMs: 60_000, shouldRetry: isUploadRateLimited },
      ),
    );
    log(`建稿成功 BV=${bv}`);

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]!;
      // 单文件 append → 安全重试(601 冷却后重试;其余错误只要「结果不确定」就不重试)。
      await withGate(uploadGate, accountKey, () =>
        withRetry(
          () => appendGroup({ ...meta, bv, files: [aliasFor(p.plain, i + 1, totalParts)] }),
          { tries: 5, backoffMs: 60_000, shouldRetry: (e) => isUploadRateLimited(e) || !isAppendAmbiguous(e) },
        ),
      );
      log(`已 append 分 P ${i + 1}/${totalParts}: ${path.basename(p.plain)}`);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // 已建稿(建稿后 append 失败)时把 bv 一并落盘 —— master 回读 failed+bv → 转人工核对分 P,不重传。
    writeNodeResult(stageSub, { phase: "failed", ok: false, error: msg, bv: bv || undefined, products }, log);
    throw e;
  }

  // 上传成功即落 `done`:清理是 best-effort,即便清理阶段意外抛错,master 也应知道「稿件已建好」。
  writeNodeResult(stageSub, { phase: "done", ok: true, bv, products }, log);

  // 上传完成 → 清掉上传别名(硬链接,不占空间,但留在 stage 里会干扰后续幂等推导)。
  try { rmSync(path.join(stageSub, UPLOAD_ALIAS_DIR), { recursive: true, force: true }); } catch { /* 忽略 */ }

  // 清理源文件(可选,与 master cleanup.sourceAfterDone 同义)。
  //
  // **`.xml` 一律保留**:本路径不 pull、也从不把 xml 复制进 stage ⇒ 节点源 xml 恒为**最后一份**
  // ⇒ 任何 `cleanStageAfterDone` 取值下都不能删(删了就永久丢失弹幕,AGENTS.md 硬约束)。
  // (曾经写成「跟着 cleanStageAfterDone 走」——那是常规 pull 路径的规则,它的前提是 stage 里有
  //  pull 来的 xml 副本;本路径没有,照搬会在 stageAfterDone=false 时删掉唯一副本。)
  if (spec.cleanSourceAfterDone) {
    const all = [...spec.tsFiles];
    for (const f of all) { try { rmSync(f, { force: true }); } catch { /* 忽略 */ } }
    log(`已清理节点源文件 ${all.length} 个(保留 .xml:它是最后一份)`);
  }

  // 清理节点 stage 产物(可选,与 master cleanup.stageAfterDone 同义)。
  //
  // 为什么必须做:节点侧路径**没有 pull** ⇒ master 的 stage 里只有 job.log(节点管线不往那儿写产物),
  // 而 master 的 `clean_stage` 只清 **master 自己的** stageSub ⇒ 节点 stage 里的
  // `{stem}_NNN.mp4`(逐段无损 remux 的**成品**)与 `.work/`(同量级中间产物)永远没人清。
  // 线上实测泄漏:VPS2 `~/drec/stage/douyin_249293641318_2026-10-12/` = 1.8G(mp4 + .work 双份)。
  //
  // 安全性:能走到这里说明**上传已成功**(BV 已拿到),B站那份才是交付物,节点本地这份是冗余副本;
  // 且节点侧不烧录、不回传,stage 里没有「唯一副本」性质的 .xml(节点源 xml 的保留见上一段)。
  // `.xml/.ass` 跟随 `xmlKeepRule("stage", true)`(= stageAfterDone 开时 stage 侧可删),
  // 与节点源那段**恰好互补** → 永不出现「两处同时删光」。
  if (spec.cleanStageAfterDone) {
    // deleteXml=false **故意**:节点侧没有 pull ⇒ stage 里从来不会出现 xml 副本(节点产物只有
    // remux 出来的 mp4)。这里的 .xml/.ass 只可能是**残留的唯一副本** ⇒ 一律保留,
    // 绝不冒「删掉最后一份弹幕」的险(AGENTS.md 硬约束)。
    const targets = nodeStageCleanupTargets(stageSub);
    for (const t of targets) { try { rmSync(t, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    log(`已清理节点 stage 产物 ${targets.length} 个(${path.basename(stageSub)})`);
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

/**
 * 节点 stage 目录里「上传成功后即可删」的路径(与 master 的 `clean_stage` 同一口径)。
 *
 * 删什么:
 *   - 所有 `.mp4` —— 上传成功后 B站那份才是交付物,本地是冗余副本;
 *   - `.work/` —— 逐段 remux/合并的中间产物,与成品同量级(不删就是双份磁盘);
 *   - `.upload/` —— 分 P 标题硬链接别名目录(正常情况下上传后已删,残留时一并收掉);
 *   - `.xml/.ass` —— **仅** `opts.deleteXml` 显式打开时。节点侧上传**不要**开:
 *     它从不把 xml 拉回/复制进 stage ⇒ stage 里的 xml 只会是唯一副本,删了就永久丢弹幕。
 *
 * 注意**不删** `job.log` 之类:节点侧管线只写 stderr,但将来若加节点本地日志,不能顺手删掉。
 */
export function nodeStageCleanupTargets(
  stageSub: string,
  opts: { deleteXml?: boolean; deleteProducts?: boolean } = {},
): string[] {
  const names = readdirSyncSafeNames(stageSub);
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(stageSub, n);
    // 中间产物/别名目录:无论 stage 是否保留都不该留(它们不是交付物,且与成品同量级)。
    if (n === UPLOAD_ALIAS_DIR || n === ".work") out.push(p);
    else if (opts.deleteProducts !== false && /\.mp4$/i.test(n)) out.push(p);
    else if (opts.deleteXml && /\.(xml|ass)$/i.test(n)) out.push(p);
  }
  return out;
}

/** 读目录(失败 → 空数组;清理路径用,绝不反噬)。 */
function readdirSyncSafeNames(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
