/**
 * segment-pipeline.ts — **分段上传**路径(steps.mergeSegments=false)。
 *
 * 从 pipeline.ts 抽出:不合并,按录制分段(每个 .ts/.flv)产出并上传,每段/每组合并后 = 一个分 P。
 *
 * 流程:逐段 remux(→ <stage>/.work/) → 按 segmentGroupSec 聚组并合并(→ {name}_{NNN}.mp4)
 *       → 可选逐组烧录(段窗口切弹幕) → P1 建稿 + 逐组 append → 清理。
 * 幂等/续跑:sync_node_states(merge / burn_* / upload_plain / append_*)+ sync_parts(每分 P checkpoint)。
 */
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { isAppendAmbiguous, isUploadRateLimited, throwIfAborted } from "@drec/core";
import { planSegmentGroups } from "@drec/post-process";
import type { Broadcast } from "./identity.js";
import type { JobState } from "./ledger.js";
import { retry } from "./retry.js";
import { segmentStem, segWorkPath, type SegmentPlan } from "./session-plan.js";
import { defaultRmStage, defaultSplitForUpload, readdirSyncSafe, videoOnly, xmlKeepRule, type PipelineDeps } from "./pipeline.js";

/** 默认单段 remux(ts/flv → mp4,无损,-c copy + 时基钉 90000)。 */
const defaultRemuxSegment = (src: string, out: string): Promise<void> =>
  import("@drec/post-process").then((m) => m.remuxSegment(src, out));

/** 默认单段时长探测(ffprobe)。 */
const defaultSegmentDuration = (src: string): Promise<number> =>
  import("@drec/post-process").then((m) => m.ffprobeDuration(src));

/** 默认组内合并:与合并路径同款(逐段 mpegts 规范化 + concat -c copy),顺带把时基修正为 90000。 */
const defaultMergeSegments = (inputs: string[], outMp4: string): Promise<void> =>
  import("@drec/post-process").then((m) => m.mergeSession(inputs, outMp4));

/** 默认单段烧录:读该会话 xml → 按段窗口切 ASS(时间重定基) → burn。窗口内无弹幕则跳过(不产出)。 */
async function defaultBurnSegment(o: {
  plain: string;
  xmlPath: string;
  window: { startSec: number; endSec: number };
  style: "danmu" | "livechat";
  out: string;
}): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { renderXmlWindowToAss, burn, FONTS_DIR, ffprobeVideo } = await import("@drec/post-process");
  const xml = readFileSync(o.xmlPath, "utf-8");
  let dim: { width?: number; height?: number } = {};
  try { const v = await ffprobeVideo(o.plain); if (v.width > 0) dim = { width: v.width, height: v.height }; } catch { /* 无维度 → 用默认 */ }
  const { ass } = renderXmlWindowToAss(xml, o.style, o.window, { giftValueFilter: 0.9, ...dim });
  if (!ass) return; // 窗口内无弹幕 → 不产出(调用方按文件存在与否回落 plain 段)
  await burn({ inputMp4: o.plain, assText: ass, outMp4: o.out, fontsDir: FONTS_DIR, hwaccel: "auto" });
}
/**
 * 经**全局上传队列**执行一次上传/append 提交。队列 = master 进程内共享(ResourcePool),
 * 串行 + 相邻提交最小间隔(uploadMinGapMs)→ 多任务同时收播时排队,且不会瞬时打爆 B 站频率限制。
 * 无 pool(测试/兼容)则直连。
 */
function runUpload<T>(deps: PipelineDeps, fn: () => Promise<T>): Promise<T> {
  return deps.pool ? deps.pool.withUpload(fn) : fn();
}

/** 分段上传的一个"分 P"产物(单段直接 remux 或若干段合并成组)。 */
interface SegmentUploadPart {
  index: number;
  /** 待上传的 plain mp4(单段 = 该段 remux;组 = 合并产物)。 */
  plain: string;
  /** 该分 P 对应的弹幕窗口(组内各段窗口的并集);无 xml 则 null。 */
  window: { startSec: number; endSec: number; xmlPath: string } | null;
  /** 构成该分 P 的逐段 plain(清理时用)。 */
  memberPlains: string[];
  danmu?: string;
  livechat?: string;
}

/** 组内各段的弹幕窗口并集([min start, max end)),xml 取组内首个有 xml 的段。 */
function spanWindow(members: Array<{ window: { startSec: number; endSec: number } | null; xmlPath: string }>): { startSec: number; endSec: number; xmlPath: string } | null {
  const withWin = members.filter((m) => m.window && m.xmlPath);
  if (withWin.length === 0) return null;
  const startSec = Math.min(...withWin.map((m) => m.window!.startSec));
  const endSec = Math.max(...withWin.map((m) => m.window!.endSec));
  const xmlPath = withWin[0].xmlPath;
  return { startSec, endSec, xmlPath };
}
/**
 * 分段产出流水线(steps.mergeSegments=false):**不合并**。
 *
 * 逐段 remux(ts/flv → mp4,无损,不拼接) → 可选逐段烧录(用该段在整场 xml 时间轴上的窗口)
 * → 上传:全部 plain 段**一次多文件 upload** 建稿(P1..Pn 顺序 = 段序),再逐组 append
 * danmu / livechat 各段(组内多段一次 append,顺序 = 段序)。
 *
 * 幂等/续跑:与合并路径共用 sync_node_states(stage=merge 记 remux,burn_* / upload_plain / append_*)。
 * `merge` 节点 = 「逐段 remux 产出 plain 段」,upload_plain = 「多文件建稿」,append_* = 「追各段组」。
 * 续跑:已建稿(bv 存在)→ 只补 append;plain 段已在 stage → remux 跳过重做。
 */
export async function runSegmentPipeline(o: {
  streamKey: string;
  deps: PipelineDeps;
  jlog: (msg: string) => void;
  stageSub: string;
  winnerMembers: Broadcast["members"];
  allMembers: Broadcast["members"];
  dateName: string;
}): Promise<{ state: JobState; bv?: string }> {
  const { streamKey, deps, jlog, stageSub, winnerMembers, allMembers, dateName } = o;
  const { ledger, notify, cfg } = deps;
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;
  const clean = cfg.cleanup ?? {};
  const rmStage = deps.rmStage ?? defaultRmStage;
  const splitForUpload = deps.splitForUpload ?? defaultSplitForUpload;
  // 逐段 sh:命令行 + 耗时 + 输出摘尾进 job.log(与合并路径一致)。
  const sh = async (cmd: string): Promise<void> => {
    jlog(`$ ${cmd}`);
    const t0 = Date.now();
    const out = await deps.sh(cmd);
    jlog(`  ✓ 完成(${Math.round((Date.now() - t0) / 1000)}s)`);
    if (typeof out === "string" && out.trim()) jlog(`  输出尾: ${out.trim().slice(-2048)}`);
  };

  // 续跑:已建稿(bv 已落库)→ 只补没做完的 append,绝不重传 plain 组(会重复建稿)。
  const existing = ledger.get(streamKey);

  // 该场各段的 remux 输入(按会话序 → 段序,已由 winnerMembers.tsFiles 保证)。
  const srcSegments = winnerMembers.flatMap((m) => m.rec.tsFiles);
  if (srcSegments.length === 0) {
    jlog(`分段模式:无可用分段`);
    ledger.markFailed(streamKey, "无可用分段");
    return { state: "failed" };
  }
  // 先按碎片阈值算出**本次允许的段号白名单**(原始段序)——主路径与续跑共用,
  // 确保续跑不会把 stage 里残留的碎片 seg mp4 也当成分段上传(踩过坑)。
  const probeDurationScan = deps.segmentDuration ?? defaultSegmentDuration;
  const minSegSecScan = cfg.minSegmentSec ?? 2;
  const allowedIndices = new Set<number>();
  {
    let off = 0;
    for (let i = 0; i < srcSegments.length; i++) {
      const localSrc = path.join(stageSub, path.basename(srcSegments[i]));
      let d = 0;
      try { d = await probeDurationScan(localSrc); } catch { d = 0; }
      off += d;
      if (minSegSecScan > 0 && d > 0 && d < minSegSecScan) continue; // 碎片:不进白名单
      allowedIndices.add(i);
    }
  }

  // ── 逐段 remux(merge 节点语义)──
  ledger.setState(streamKey, "merging");
  ledger.logStep(streamKey, "merge", "start");
  ledger.syncNodeState(streamKey, "merge", "running");
  const parts: SegmentPlan["parts"] = [];
  const xmlCache = new Map<string, string>();
  // 每个会话内累计时长 = 该会话后续段的窗口起点(与合并路径的弹幕偏移口径一致)。
  let globalOffset = 0;
  const remux = deps.remuxSegment ?? defaultRemuxSegment;
  const probeDuration = deps.segmentDuration ?? defaultSegmentDuration;
  const minSegSec = cfg.minSegmentSec ?? 2;
  let skippedFragments = 0;
  for (let i = 0; i < srcSegments.length; i++) {
    throwIfAborted();
    const remoteSrc = srcSegments[i];
    // pull 后源在 stage 内同名;remux 读本地副本(remote 路径只在 pull 时用过)。
    const localSrc = path.join(stageSub, path.basename(remoteSrc));
    let durSec = 0;
    try { durSec = await probeDuration(localSrc); } catch { durSec = 0; }
    // 段窗口(相对整场):从 globalOffset 起 durSec 秒。源缺失时长按 0 计(弹幕可能漂移,但不静默)。
    const startSec = globalOffset;
    globalOffset += durSec;
    // 碎片过滤:mesio `--fix` 切出的 0.2s 级初始化残片(分辨率不同、无有效内容)→ 不产出。
    // 仍累加 globalOffset(时长约 0),保证后续段的弹幕窗口对齐。
    if (minSegSec > 0 && durSec > 0 && durSec < minSegSec) {
      skippedFragments++;
      jlog(`跳过碎片段 ${i}: ${path.basename(localSrc)}(${durSec.toFixed(2)}s < ${minSegSec}s)`);
      continue;
    }
    // 逐段 remux 是**中间产物**,落在 stageSub/.work/ 下的纯段号文件(不与上传产物撞名)。
    const plain = segWorkPath(stageSub, i);
    mkdirSync(path.dirname(plain), { recursive: true });
    if (!existsSync(plain)) {
      jlog(`remux 段 ${i}: ${path.basename(localSrc)} → ${path.basename(plain)}`);
      await remux(localSrc, plain);
    } else {
      jlog(`remux 段 ${i}: 已存在,跳过 ${path.basename(plain)}`);
    }
    // 该段所属会话的 xml(stage 内同名);按会话缓存内容,避免重复读。
    const sessionXml = winnerMembers.find((m) => m.rec.tsFiles.includes(remoteSrc))?.rec.xmlPath;
    const xmlStage = sessionXml ? path.join(stageSub, path.basename(sessionXml)) : "";
    let xmlText = "";
    if (xmlStage && existsSync(xmlStage)) {
      xmlText = xmlCache.get(xmlStage) ?? "";
      if (!xmlText) { const { readFileSync } = await import("node:fs"); xmlText = readFileSync(xmlStage, "utf-8"); xmlCache.set(xmlStage, xmlText); }
    }
    parts.push({
      index: parts.length, src: localSrc, plain, srcSegIndex: i, durSec,
      xmlPath: xmlText ? xmlStage : "",
      window: xmlText ? { startSec, endSec: startSec + durSec } : null,
      danmu: "", livechat: "",
    });
  }

  // ── 近似分段时长合并:把逐段 remux 的 plain 按目标时长聚组成"分 P"──
  // mesio 的 split operator 把一场切成 11+ 个长短不一的段(还有一堆 0.2s 碎片);
  // 逐段上传会产生十几个分 P,且都短于录制时设置的 segmentSec。这里按 segmentSec 把
  // 连续段合并成接近目标时长的组 → 每组 = 一个分 P(与合并路径的产出形态一致)。
  const groupTargetSec = cfg.segmentGroupSec ?? 0; // <=0 = 不合并(逐段上传)
  const planGroups = groupTargetSec > 0
    ? planSegmentGroups(parts.map((p) => p.durSec ?? 0), groupTargetSec)
    : parts.map((_, i) => [i]);
  const mergeGroup = deps.mergeSegments ?? defaultMergeSegments;
  const uploadParts: SegmentUploadPart[] = [];
  for (let gi = 0; gi < planGroups.length; gi++) {
    const memberIdxs = planGroups[gi];
    const members = memberIdxs.map((k) => parts[k]);
    // 上传产物统一命名 {dateName}_{NNN}.mp4(NNN=分 P 序号,与 hub 命名约定一致)。
    const out = path.join(stageSub, `${segmentStem(dateName, gi)}.mp4`);
    if (members.length === 1) {
      // 不合并 / 单段组:中间产物直接复制/改名成规范上传名(不能直接引用 .work 里的文件)。
      if (!existsSync(out)) {
        const { copyFileSync } = await import("node:fs");
        copyFileSync(members[0].plain, out);
      }
    } else if (!existsSync(out)) {
      jlog(`合并组 ${gi}: ${members.length} 段(≈${Math.round(members.reduce((n, m) => n + (m.durSec ?? 0), 0))}s)→ ${path.basename(out)}`);
      await mergeGroup(members.map((m) => m.plain), out);
    } else {
      jlog(`合并组 ${gi}: 已存在,跳过 ${path.basename(out)}`);
    }
    uploadParts.push({ index: gi, plain: out, window: spanWindow(members), memberPlains: members.map((m) => m.plain) });
  }
  jlog(`产出: ${parts.length} 有效段 → ${uploadParts.length} 个分 P(目标 ${groupTargetSec || "未设"}s)`);
  ledger.logStep(streamKey, "merge", "done", `${parts.length} 段 → ${uploadParts.length} 个分 P${skippedFragments ? `(跳过 ${skippedFragments} 碎片)` : ""}`);
  ledger.syncNodeState(streamKey, "merge", "done", { error: null });

  // 续跑:已建稿(bv 已落库)→ 只补没做完的 append(plain 剩余段 / danmu / livechat)。
  if (cfg.uploadMode === "upload" && existing?.bv) {
    return await resumeSegmentAppends(streamKey, existing.bv, stageSub, uploadParts, deps, jlog, burnDanmu, burnLivechat, isPublic, splitForUpload);
  }

  // ── 逐段烧录(burn_danmu / burn_livechat 节点语义)──
  const burnOne = deps.burnSegment ?? defaultBurnSegment;
  const burnAll = async (style: "danmu" | "livechat", node: "burn_danmu" | "burn_livechat"): Promise<void> => {
    const on = style === "danmu" ? burnDanmu : burnLivechat;
    if (!on) { ledger.syncNodeState(streamKey, node, "skipped"); return; }
    ledger.logStep(streamKey, node, "start");
    ledger.syncNodeState(streamKey, node, "running");
    let burned = 0;
    for (const p of uploadParts) {
      throwIfAborted();
      const out = p.plain.replace(/\.mp4$/i, style === "danmu" ? "_danmu.mp4" : "_livechat.mp4");
      // 无弹幕窗口 → 该组无弹幕可烧,回落 plain(不产出 *_danmu.mp4)。
      if (!p.window) { jlog(`${node} 组 ${p.index}: 无弹幕,跳过`); continue; }
      if (!existsSync(out)) {
        jlog(`${node} 组 ${p.index}: ${path.basename(p.plain)} → ${path.basename(out)}`);
        // 默认实现内部:窗口内无弹幕 → 不产出文件(回落 plain 段)。烧完按存在与否记产物。
        await burnOne({ plain: p.plain, xmlPath: p.window.xmlPath, window: p.window, style, out });
      } else {
        jlog(`${node} 组 ${p.index}: 已存在,跳过 ${path.basename(out)}`);
      }
      if (existsSync(out)) {
        if (style === "danmu") p.danmu = out; else p.livechat = out;
        burned++;
      } else {
        jlog(`${node} 组 ${p.index}: 窗口内无弹幕,跳过`);
      }
    }
    ledger.logStep(streamKey, node, "done", `${burned}/${uploadParts.length} 组`);
    ledger.syncNodeState(streamKey, node, "done", { error: null });
  };
  await burnAll("danmu", "burn_danmu");
  await burnAll("livechat", "burn_livechat");

  // ── stage 模式:逐段产物落盘待人工,不建稿 ──
  if (cfg.uploadMode !== "upload") {
    jlog(`分段 stage 模式:${uploadParts.length} 个分 P 已合成待人工上传`);
    ledger.setState(streamKey, "needs_manual");
    notify({ kind: "stageReady", streamKey });
    return { state: "needs_manual" };
  }

  // ── 上传:全部 plain 段一次多文件 upload 建稿(P1..Pn 顺序 = 段序)──
  ledger.setState(streamKey, "uploading");
  ledger.logStep(streamKey, "upload_plain", "start");
  ledger.syncNodeState(streamKey, "upload_plain", "running");
  const plainFiles = uploadParts.map((p) => p.plain).filter(existsSync);
  if (plainFiles.length === 0) {
    jlog(`分段上传:无 plain 段产物`);
    ledger.syncNodeState(streamKey, "upload_plain", "failed", { error: "无 plain 段产物" });
    ledger.markFailed(streamKey, "分段上传:无 plain 段产物");
    notify({ kind: "error", stage: "上传", message: `${streamKey} 分段上传无 plain 段产物` });
    return { state: "failed" };
  }
  // 提交频率硬上限:一次 `biliup upload` 提交太多文件会触发 B 站 601(上传过快)。
  // 故 P1 单文件建稿拿 BV → 其余 plain 段分批 append(每批 ≤uploadBatchSize,批间走全局上传队列的间隔)。
  const batchSize = Math.max(1, cfg.uploadBatchSize ?? 1);
  const plainOpts = {
    cookies: cfg.cookies, tag: cfg.uploadMeta.tag, tid: cfg.uploadMeta.tid,
    public: isPublic, desc: cfg.uploadMeta.desc,
  };
  // 分 P checkpoint:每个已成功提交的段都落库(组名 "plain"),续跑据此精确跳过 → 不漏段、不重复。
  const donePlain = ledger.doneParts(streamKey, "plain");
  let bv = "";
  let p1Done = donePlain.has(0) || ledger.get(streamKey)?.bv != null;
  if (!p1Done) {
    jlog(`建稿 P1: ${path.basename(plainFiles[0])}(${plainFiles.length} 个 plain 段待传)`);
    // P1 建稿:可用 `uploadPlain` 建稿接缝(有线路换线),也可注入 `uploadPlainRaw`(测试用)。
    // 601 频率限制 → 重试(队列会先冷却);其余错误不重试(避免重复建稿)。
    bv = await retry(
      () => runUpload(deps, () => deps.uploadPlainRaw
        ? deps.uploadPlainRaw({ ...plainOpts, video: plainFiles[0], title: dateName })
        : deps.uploadPlain({ ...plainOpts, video: plainFiles[0], title: dateName })),
      { tries: 3, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) },
    );
    ledger.setBv(streamKey, bv); // 建稿成功即刻落库(与合并路径同一幂等边界)
    ledger.markPartDone(streamKey, "plain", 0); // P1 = 第 0 段
    jlog(`建稿完成: ${bv}`);
  } else {
    bv = ledger.get(streamKey)?.bv ?? "";
    jlog(`建稿 P1 已存在,跳过(bv=${bv})`);
  }
  if (!bv) {
    jlog(`分段上传:已标 P1 完成但 bv 为空,转人工`);
    ledger.setState(streamKey, "needs_manual", { error: "分段上传:P1 已完成但 bv 为空" });
    return { state: "needs_manual" };
  }
  // 其余 plain 段逐个 append(顺序 = 段序)。每个成功即 checkpoint;601 由队列冷却 + retry 吸收。
  for (let i = 1; i < plainFiles.length; i += batchSize) {
    const batch: string[] = [];
    const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, plainFiles.length); j++) {
      if (donePlain.has(j)) continue; // 续跑:已提交的段跳过
      batch.push(plainFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    jlog(`append plain 段 ${idxs.join(",")}: ${batch.length} 文件`);
    const tries = batch.length === 1 ? 5 : 1;
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ ...plainOpts, bv, files: batch })),
      { tries, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) || (batch.length === 1 && !isAppendAmbiguous(e)) },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, "plain", k);
  }
  ledger.logStep(streamKey, "upload_plain", "done", `P1 + ${plainFiles.length - 1} 段`);
  ledger.syncNodeState(streamKey, "upload_plain", "done", { error: null });

  // ── 逐组 append:danmu 各段一组、livechat 各段一组(组内多段一次 append,顺序 = 段序)──
  await appendSegmentGroup(streamKey, bv, "append_danmu", uploadParts.map((p) => p.danmu).filter((f): f is string => !!f && existsSync(f)), burnDanmu, deps, jlog, isPublic, splitForUpload);
  await appendSegmentGroup(streamKey, bv, "append_livechat", uploadParts.map((p) => p.livechat).filter((f): f is string => !!f && existsSync(f)), burnLivechat, deps, jlog, isPublic, splitForUpload);

  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });

  // 可选清理:各成员节点原录制。.ts 总删;.xml 仅当 stage 保留时一起删(xmlKeepRule(node,...))。
  if (clean.sourceAfterDone) {
    const delNodeXml = xmlKeepRule("node", clean.stageAfterDone === true);
    ledger.logStep(streamKey, "clean_source", "start");
    let fileCount = 0;
    for (const m of allMembers) {
      const paths = videoOnly(m.rec.tsFiles);
      if (delNodeXml && m.rec.xmlPath) paths.push(m.rec.xmlPath);
      fileCount += paths.length;
      await deps.transports.get(m.workerId)?.cleanup?.(paths).catch(() => {});
    }
    ledger.logStep(streamKey, "clean_source", "done", `删 ${allMembers.length} 节点 · ${fileCount} 文件`);
  }
  // 可选清理:stage 里拉来的源 .ts;不保留 stage 时连 .xml/.ass 副本一起删。
  if (clean.stageSourceAfterMerge) {
    const srcStage = srcSegments.map((f) => path.join(stageSub, path.basename(f)));
    if (xmlKeepRule("stage", clean.stageAfterDone === true)) {
      srcStage.push(...readdirSyncSafe(stageSub).filter((f) => /\.(xml|ass)$/i.test(f)).map((f) => path.join(stageSub, f)));
    }
    ledger.logStep(streamKey, "clean_stage_src", "start");
    await rmStage(srcStage);
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${srcStage.length} 文件`);
  }
  if (clean.stageAfterDone) {
    // 组产物(合并 mp4 / 烧录 mp4)+ 组成员的逐段 plain(若合并成组则逐段 plain 可一并清)。
    const products = videoOnly([
      ...uploadParts.flatMap((p) => [p.plain, p.danmu, p.livechat].filter(Boolean) as string[]),
      ...(groupTargetSec > 0 ? uploadParts.flatMap((p) => p.memberPlains) : []),
    ]).filter(existsSync);
    if (xmlKeepRule("stage", true)) {
      products.push(...readdirSyncSafe(stageSub).filter((f) => /\.(xml|ass)$/i.test(f)).map((f) => path.join(stageSub, f)));
    }
    ledger.logStep(streamKey, "clean_stage", "start");
    await rmStage(products);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length} 文件`);
  }
  return { state: "done", bv };
}

/** 分段 append 一个逻辑组(danmu 或 livechat 的全部段)。组内多段 = 一次 append(顺序 = 段序)。 */
async function appendSegmentGroup(
  streamKey: string,
  bv: string,
  step: "append_danmu" | "append_livechat",
  files: string[],
  on: boolean,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  isPublic: boolean,
  splitForUpload: (mp4: string) => Promise<string[]>,
): Promise<void> {
  const { ledger } = deps;
  if (!on) { ledger.syncNodeState(streamKey, step, "skipped"); return; }
  if (ledger.isStepDone(streamKey, step)) { jlog(`append 跳过(已完成): ${step}`); return; }
  if (files.length === 0) {
    jlog(`${step}: 无产物段,跳过`);
    ledger.syncNodeState(streamKey, step, "skipped");
    return;
  }
  // 每个产物段再按 16GB 上限切(罕见),展平成最终 append 文件列表(顺序保持)。
  const finalFiles: string[] = [];
  for (const f of files) finalFiles.push(...await splitForUpload(f));
  ledger.logStep(streamKey, step, "start");
  ledger.syncNodeState(streamKey, step, "running");
  // 分批 append(每批 ≤uploadBatchSize):每次提交走全局上传队列(限速 + 601 冷却)。
  // 每组按段号落 checkpoint(sync_parts),续跑精确跳过 → 不漏段、不重复分 P。
  const batchSize = Math.max(1, deps.cfg.uploadBatchSize ?? 1);
  const doneParts = ledger.doneParts(streamKey, step);
  let batches = 0;
  for (let i = 0; i < finalFiles.length; i += batchSize) {
    const batch: string[] = []; const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, finalFiles.length); j++) {
      if (doneParts.has(j)) continue;
      batch.push(finalFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    batches++;
    jlog(`append ${step} 批 ${batches}: ${batch.length} 文件(段 ${idxs.join(",")})`);
    // 单文件批(默认)→ 601 可安全重试(最多 5 次,每次重新排队 = 走冷却);多文件批不重试(可能已部分提交)。
    const tries = batch.length === 1 ? 5 : 1;
    // retry 包在 runUpload 外:每次重试都重新获取上传配额(命中 601 后队列已记冷却)。
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ bv, files: batch, cookies: deps.cfg.cookies, public: isPublic })),
      {
        tries,
        backoffMs: 60_000,
        sleep: deps.sleep,
        shouldRetry: (err) => isUploadRateLimited(err) || !isAppendAmbiguous(err),
        onRetry: (attempt, err) => jlog(`append ${step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
      },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, step, k);
  }
  ledger.logStep(streamKey, step, "done", `${finalFiles.length} 文件 · ${batches} 批`);
  ledger.syncNodeState(streamKey, step, "done", { error: null });
  jlog(`append ${step} 完成(${finalFiles.length} 文件,${batches} 批)`);
}

/** 分段模式续跑:已建稿 → 只补没做完的 append(plain 剩余分 P / danmu / livechat)。 */
async function resumeSegmentAppends(
  streamKey: string,
  bv: string,
  stageSub: string,
  uploadParts: SegmentUploadPart[],
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  burnDanmu: boolean,
  burnLivechat: boolean,
  isPublic: boolean,
  splitForUpload: (mp4: string) => Promise<string[]>,
): Promise<{ state: JobState; bv?: string }> {
  const { ledger, notify, cfg } = deps;
  jlog(`分段续跑:已建稿 bv=${bv},只补 append`);
  if (uploadParts.length === 0) {
    jlog(`分段续跑失败:无可上传分 P`);
    ledger.setState(streamKey, "needs_manual", { error: `分段续跑失败:bv=${bv} 但无可上传分 P` });
    notify({ kind: "error", stage: "上传", message: `分段续跑失败:${bv} 产物缺失,请人工核对分 P` });
    return { state: "needs_manual", bv };
  }
  // 先补 plain:已建稿但其余分 P 可能还没传完(上次在 append plain 中途失败)。
  const plainFiles = uploadParts.map((p) => p.plain).filter((f) => f && existsSync(f));
  const donePlain = ledger.doneParts(streamKey, "plain");
  const batchSize = Math.max(1, cfg.uploadBatchSize ?? 1);
  for (let i = 0; i < plainFiles.length; i += batchSize) {
    const batch: string[] = []; const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, plainFiles.length); j++) {
      if (donePlain.has(j)) continue;
      batch.push(plainFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    jlog(`续跑 append plain 分 P ${idxs.join(",")}`);
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ bv, files: batch, cookies: cfg.cookies, public: isPublic })),
      { tries: batch.length === 1 ? 5 : 1, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) || (batch.length === 1 && !isAppendAmbiguous(e)) },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, "plain", k);
  }
  ledger.syncNodeState(streamKey, "upload_plain", "done", { error: null });
  const danmuFiles = uploadParts.map((p) => p.danmu).filter((f): f is string => !!f && existsSync(f));
  const livechatFiles = uploadParts.map((p) => p.livechat).filter((f): f is string => !!f && existsSync(f));
  await appendSegmentGroup(streamKey, bv, "append_danmu", danmuFiles, burnDanmu, deps, jlog, isPublic, splitForUpload);
  await appendSegmentGroup(streamKey, bv, "append_livechat", livechatFiles, burnLivechat, deps, jlog, isPublic, splitForUpload);
  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  if (cfg.cleanup?.stageAfterDone) {
    const rmStage = deps.rmStage ?? defaultRmStage;
    const products = videoOnly([
      ...uploadParts.flatMap((p) => [p.plain, p.danmu, p.livechat].filter(Boolean) as string[]),
      ...uploadParts.flatMap((p) => p.memberPlains),
    ]).filter(existsSync);
    if (xmlKeepRule("stage", true)) {
      products.push(...readdirSyncSafe(stageSub).filter((f) => /\.(xml|ass)$/i.test(f)).map((f) => path.join(stageSub, f)));
    }
    await rmStage(products);
  }
  return { state: "done", bv };
}
