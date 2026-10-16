/**
 * node-remux.ts — 节点侧「原地替换容器」(issue #137 第 2/2)。
 *
 * 只作用于**无后处理的任务**:每个录制分段**封口后**在节点上 `-c copy` remux 成任务所选容器(mp4/mkv),
 * 校验通过后删除原文件,新文件成为 source;**绝不并存两份**。`original` 时本模块完全不参与。
 *
 * 硬边界:
 *   - 只碰已封口分段(封口判定复用 core `sealedSegmentIndices`,与边录边传同一份):正在写的分段绝不动;
 *     会话收尾(`await recorder.stop()` 之后)再补转最后一段。
 *   - 先写临时文件 `{新名}.drec-remux`(非视频扩展名 → 任何扫描/分组/孤儿清理都不会当成分段),
 *     校验通过才 fsync + 原子 rename 成最终名,再删原文件。任一步失败:删临时文件、**保留原文件**、告警。
 *   - 永不删到最后一份:原文件只在「新文件已校验并落到最终名」之后才删。校验 = {@link verifyRemuxed}(扫包取末帧
 *     + 大小比例,识别截断/损坏),正常路径与崩溃接管路径**共用同一个函数**;接管时新文件存疑 → 两份都留。
 *   - 转换串行(并发上限 1)、fire-and-forget,不阻塞录制;失败不影响后续分段。
 *   - 崩溃接管见 {@link recoverNodeRemux}。
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  convertSegmentInPlace,
  defaultPidAlive,
  defaultProbe,
  markSessionNodeFormat,
  NODE_REMUX_SUSPECT_SUFFIX,
  NODE_REMUX_TMP_SUFFIX,
  ownerKey,
  parseRemuxTmpName,
  readNodeFormat,
  rmQuiet,
  verifyRemuxed,
  type NodeRemuxDeps,
} from "@drec/processors";
import {
  platformForRoom,
  sealedSegmentIndices,
  sessionBaseOf,
  STAGE_CONTAINERS,
  survivingArtifacts,
  isUploadingMode,
  pipelineBurns,
  type OutputFormat,
  type OutputFormatLock,
  type RollingSegment,
  type StageFormat,
} from "@drec/core";
import type { RollingUploadHook } from "@drec/manager";
import { listHubRules, hubKey, type HubRule } from "./hub-store.js";
import type { RemuxQueueLike } from "./remux-queue.js";
import type { Task } from "./store.js";

// 校验 / 原地转换 / 临时名命名 / 阈值 / 边车标记已搬入 `@drec/processors`(plans/036 T6,逐字搬入、命名不变);
// 此处原样再导出,保持 `@drec/app` 对外 API 与既有测试的 import 路径不变。
export {
  convertSegmentInPlace, DURATION_TOLERANCE_RATIO, DURATION_TOLERANCE_SEC, durationToleranceSec, markSessionNodeFormat,
  MIN_SIZE_RATIO, NODE_REMUX_SUSPECT_SUFFIX, NODE_REMUX_TMP_SUFFIX, packetAllowance, parseRemuxTmpName, PROBE_BOUND_MS,
  REMUX_DISK_HEADROOM_BYTES, remuxTargetPath, remuxTmpPath, SPAN_TOLERANCE_RATIO, SPAN_TOLERANCE_SEC, verifyRemuxed,
  type MediaProbe, type NodeRemuxDeps, type RemuxOutcome,
} from "@drec/processors";

/**
 * 崩溃接管只删「足够旧」的孤儿临时文件。接管扫的是共享输出根(含其他任务正在转换的目录),
 * 新鲜的临时文件可能正被另一个任务的 ffmpeg 写。依据:单段 remux 是顺序 `-c copy`,
 * 30 分钟的段在机械盘上也只需几分钟;2 小时远大于最长合理转换时间。正在写的文件 mtime 持续刷新,永远不会被判旧。
 */
export const STALE_TMP_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * 会话收尾(`onSessionEnd`,停录 / 断流重连前)等待转换的总时限。依据:单个 30 分钟分段 remux(`-c copy`,秒~分钟级)
 * + 校验(两次探测,各数秒~数十秒)正常在 1 分钟内;3 分钟 ≈ 3 倍裕量。再久会拖住断流重连(丢流)与停录,
 * 超时 = 放弃本次转换(原文件保留)并告警,转换留给下次启动的崩溃接管 / 人工。
 */
export const SESSION_END_BUDGET_MS = 3 * 60_000;

/** 崩溃接管整体时限:接管在后台跑、不挡录制,但也不能无限占着探测进程。依据:扫描里同时存在的配对一般 ≤ 数十个,逐个校验 30 分钟绰绰有余。 */
export const RECOVER_TOTAL_TIMEOUT_MS = 30 * 60_000;

/**
 * 一个任务的原地替换钩子工厂(manager 的 `makeRolling` 接缝)。
 *
 * 封口 → **入队**(`o.queue`,plans/036 T6):入队前先写会话边车 `nodeFormat`(同旧行为:崩溃后凭它识别配对);
 * 转换由任务表的 runner 按租约规则执行(并发上限 / 磁盘准入 / 崩溃续跑 / 关停回 pending 都在 runner 侧)。
 * 收尾(`onSessionEnd`)保留 {@link SESSION_END_BUDGET_MS} 总时限等待本进程入队的行,超时告警、未完成行留在表中。
 *
 * **回落(稳定版兜底)**:无 `o.queue`(任务表打不开)或某段入队失败 → 该段走**进程内串行链**(旧实现原样:并发上限 1,
 * 跨会话也不并发)+ 告警。remux 是 CPU/IO 重活,多个分段同时转会拖垮同机录制。
 */
export function makeNodeRemuxHookFactory(
  o: { format: StageFormat; sessionEndBudgetMs?: number; queue?: RemuxQueueLike | null } & NodeRemuxDeps,
): () => RollingUploadHook {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  let queueFailureAlerted = false;
  return () => {
    const indexByPath = new Map<string, number>();
    const handled = new Set<string>();
    let nextIndex = 0;

    /** 一段封口:能入队就入队(返回 true);边车写失败 = 放弃本段(原文件保留 + 告警);入队失败 → false(调用方回落进程内转换)。 */
    const tryQueue = (path: string): boolean => {
      if (!o.queue) return false;
      try { markSessionNodeFormat(dirname(path), sessionBaseOf(path), o.format); }
      catch (e) {
        const msg = `分段转 ${o.format} 失败(mark-failed),已保留原文件 ${basename(path)}: 写会话标记失败: ${(e as Error).message}`;
        o.log?.(`[remux] ${msg}`);
        o.alert?.(msg);
        return true; // 已处置(放弃):不再回落(回落同样会因标记写失败而放弃)
      }
      try {
        const r = o.queue.enqueue(path, o.format);
        if (r.state !== "rejected") return true;
        o.log?.(`[remux] 入队被拒(${r.error ?? "未知"}),本段回落进程内转换: ${basename(path)}`);
        return false;
      } catch (e) {
        const msg = `处理任务表入队失败,本段回落进程内转换: ${basename(path)}: ${(e as Error)?.message ?? e}`;
        o.log?.(`[remux] ${msg}`);
        if (!queueFailureAlerted) { queueFailureAlerted = true; o.alert?.(msg); }
        return false;
      }
    };

    const flush = (recordingActive: boolean): Promise<void> => {
      const segs: RollingSegment[] = [...indexByPath.entries()].map(([p, index]) => {
        let mtimeMs = 0;
        try { mtimeMs = statSync(p).mtimeMs; } catch { mtimeMs = 0; }
        return { path: p, index, mtimeMs };
      });
      // 封口判定唯一真理 = core.sealedSegmentIndices。收尾调用方契约是录制进程已退出(最后一段不再增长),
      // 所以 grace 恒 0 且 nowMs 取 Infinity:不让「mtime 与此刻同一毫秒(或亚毫秒领先)」把末段判成未封口 → 永不转换。
      const sealed = sealedSegmentIndices(segs, { recordingActive, nowMs: Infinity, sealGraceMs: 0 });
      const todo = segs.filter((s) => sealed.has(s.index) && !handled.has(s.path)).sort((a, b) => a.index - b.index);
      for (const s of todo) handled.add(s.path); // 入队即占位:同一段绝不并发/重复转
      const fallback = todo.filter((s) => !tryQueue(s.path));
      // 收尾那次(recordingActive=false)有总时限:到点置 abandoned,后续/在途转换在检查点放弃(原文件保留)。
      const token = { abandoned: false };
      const done = enqueue(async () => {
        for (const s of fallback) {
          try { await convertSegmentInPlace(s.path, o.format, { ...o, shouldAbort: () => token.abandoned || (o.shouldAbort?.() ?? false) }); }
          catch (e) { o.log?.(`[remux] 转换抛错(忽略,保留原文件): ${(e as Error)?.message ?? e}`); }
        }
      });
      if (recordingActive) return done;
      const budget = o.sessionEndBudgetMs ?? SESSION_END_BUDGET_MS;
      const timeoutMsg = `会话收尾转 ${o.format} 超过总时限 ${Math.round(budget / 1000)}s,已放弃转换(原文件保留,留待下次启动接管/人工)`;
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          token.abandoned = true;
          o.log?.(`[remux] ${timeoutMsg}`);
          o.alert?.(timeoutMsg);
          resolve();
        }, budget);
        timer.unref?.();
      });
      const legacy = Promise.race([done, limit]).finally(() => { if (timer) clearTimeout(timer); });
      // 队列侧:等本进程入队的行落定。他人(serve)持有 → 立即结束等待(不占预算、不告超时);超时同文案告警。
      const queued = o.queue
        ? o.queue.waitSettled(budget).then((out) => {
            if (out === "timeout") { o.log?.(`[remux] ${timeoutMsg}`); o.alert?.(timeoutMsg); }
          }).catch((e: unknown) => { o.log?.(`[remux] 收尾等待异常(忽略): ${(e as Error)?.message ?? e}`); })
        : Promise.resolve();
      return Promise.all([legacy, queued]).then(() => undefined);
    };

    return {
      onSegment: (p: string): void => {
        if (!indexByPath.has(p)) indexByPath.set(p, nextIndex++);
        void flush(true); // 新段出现 = 旧段已封口;fire-and-forget,不阻塞录制
      },
      onSessionEnd: (): Promise<void> => flush(false),
    };
  };
}

export interface RecoverSummary {
  /** 删除的陈旧孤儿临时文件。 */
  removedTmp: string[];
  /** 新鲜的临时文件(可能是别的任务正在写):保留、不碰。 */
  skippedFreshTmp: string[];
  /** 配对且新文件通过校验 → 删了原文件。 */
  removedOriginal: string[];
  /** 配对但新文件存疑(校验不通过 / 无法判定)→ 两份都保留,新文件改名隔离({@link NODE_REMUX_SUSPECT_SUFFIX})。 */
  keptBoth: string[];
}

const NATIVE_EXTS = [".ts", ".flv"];

/**
 * 崩溃接管:在会话开始前扫描录制目录(`dir` 本身 + 一层子目录)。
 *   ① 孤儿临时文件 `*.drec-remux`(转换在 rename 前被打断)→ **只删 mtime 早于 {@link STALE_TMP_MIN_AGE_MS} 的**
 *      (扫的是共享输出根,新鲜的可能是别的任务正在写,绝不碰)。临时文件只在校验通过后才 rename,
 *      所以它一定不是完成品,原文件此时必然还在;删除后发告警(「上次中断、该段保持原容器」)。
 *   ② 配对(转换已 rename 但未删原文件):`{stem}.ts|flv` 与 `{stem}{fmt}` 并存,且该会话 session.json 的
 *      `nodeFormat` 等于 `fmt`(本功能留的标记,避免误伤无关的同名文件)→ 用与正常路径**同一个** {@link verifyRemuxed}:
 *      通过才删原文件;**不通过或无法判定 → 两份都留**(新文件改名隔离防重复计入)并告警,绝不删任何一份。
 */
export async function recoverNodeRemux(dir: string, fmt: StageFormat, deps: NodeRemuxDeps = {}): Promise<RecoverSummary> {
  const log = deps.log ?? ((): void => {});
  const alert = deps.alert ?? ((): void => {});
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? defaultProbe;
  const myOwner = ownerKey(deps.owner);
  const selfPid = deps.pid ?? process.pid;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const out: RecoverSummary = { removedTmp: [], skippedFreshTmp: [], removedOriginal: [], keptBoth: [] };
  const dirs = [dir];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(dir, e.name));
  } catch { return out; }
  const ext = STAGE_CONTAINERS[fmt].ext;
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(NODE_REMUX_TMP_SUFFIX)) continue;
      const p = join(d, n);
      let mtimeMs: number;
      try { mtimeMs = statSync(p).mtimeMs; } catch { continue; }
      // 归属判定:本任务(owner 相同且非空)的残留,且写它的进程已不存在 → 必是上次被强杀留下的,立即删;
      // 别的任务的新鲜残留(可能正被其 ffmpeg 写)绝不碰;其余(无归属 / 进程仍存活 / pid 被复用)只按「陈旧 > 2h」删。
      const mark = parseRemuxTmpName(n);
      const mine = !!mark && myOwner !== "" && mark.owner === myOwner && mark.pid !== selfPid && !pidAlive(mark.pid);
      if (!mine && now() - mtimeMs < STALE_TMP_MIN_AGE_MS) {
        out.skippedFreshTmp.push(p);
        log(`[remux] 接管:临时文件 ${n} 较新且不属于本任务的已死进程(可能其他任务正在转换),不碰`);
        continue;
      }
      rmQuiet(p);
      out.removedTmp.push(p);
      log(`[remux] 接管:删除孤儿临时文件 ${n}(${mine ? "本任务已死进程的残留" : "陈旧"})`);
      alert(`上次转 ${fmt} 被中断(进程被强杀/崩溃),已清理残留临时文件 ${n};该段保持原容器`);
    }
    for (const n of names) {
      if (deps.shouldAbort?.()) return out;
      if (!n.endsWith(ext)) continue;
      const stem = n.slice(0, -ext.length);
      const orig = NATIVE_EXTS.map((x) => `${stem}${x}`).find((x) => names.includes(x));
      if (!orig) continue;
      if (readNodeFormat(d, sessionBaseOf(n)) !== fmt) continue; // 无本功能标记 → 不是我们的配对,不碰
      const origPath = join(d, orig);
      const bad = await verifyRemuxed(origPath, join(d, n), probe, deps.probeBoundMs);
      // 竞态:扫的是共享输出根,可能落在另一任务「改名之后、删原文件之前」——校验期间原文件被对方删掉,
      // 此时新文件是**唯一一份**,绝不改名隐藏、不删、不告警误导,直接跳过。
      if (!existsSync(origPath)) {
        log(`[remux] 接管:${orig} 已不存在(可能刚被对方任务转换完成),跳过 ${n},不隔离`);
        continue;
      }
      if (bad) {
        // 存疑:两份都留。新文件改名隔离(防止与原文件在扫描/分组里重复计入);改名失败也不删。
        const suspect = `${join(d, n)}${NODE_REMUX_SUSPECT_SUFFIX}`;
        try { renameSync(join(d, n), suspect); } catch { /* 改名失败:原地保留 */ }
        out.keptBoth.push(join(d, n));
        log(`[remux] 接管:新文件 ${n} 未通过/无法完成校验(${bad}),两份都保留(新文件已隔离),不删任何一份`);
        alert(`上次转 ${fmt} 被中断,新文件 ${n} 校验未通过(${bad});该段保持原容器 ${orig},两份均已保留,请人工确认`);
      } else {
        rmQuiet(origPath);
        out.removedOriginal.push(join(d, orig));
        log(`[remux] 接管:新文件 ${n} 已校验,删除原文件 ${orig}`);
        alert(`上次转 ${fmt} 被中断,已接管:新文件 ${n} 校验通过,已删除原文件 ${orig}`);
      }
    }
  }
  return out;
}

/**
 * **唯一判定点**(spawn 录制子进程之前调用):该任务是否做节点侧原地替换,以及替换成什么。
 * 转不转只看 {@link shouldConvertAtSeal};用户选 original 则恒不替换。
 * 不转 → 一律 `original`(= 子进程不带该参数,行为与改动前一致)。
 * 规则**之后才绑定**的任务:已在跑的进程不受影响,下一次 spawn 起按新判定(不再替换)。
 */
export function resolveNodeOutputFormat(
  task: Pick<Task, "id" | "room" | "managedBy" | "outputFormat" | "rollingEffective">,
  hubDir: string,
): OutputFormat {
  if (task.outputFormat === "original") return "original";
  return shouldConvertAtSeal(task, hubDir) ? task.outputFormat : "original";
}

/**
 * 录制封口时是否做节点侧原地转换(`resolveNodeOutputFormat` 的**唯一输入**,与所选格式无关):
 *   - 不被 hub 管理(`managedBy !== "hub"`:worker 上的受管任务一律不适用),
 *   - 没开边录边传(`rollingEffective`:rolling 上传后删源,与原地替换互斥),
 *   - 没有 **enabled** 的 hub 规则绑定它(规则 `recording.sourceTaskId === 任务 id`,或房间键 `{platform}.{roomSlug}` 同名)
 *     —— 有规则的存档侧形态由后处理容器负责。**规则存在但 `enabled=false` 视同未绑定**:禁用规则时 hub 不处理该房间,
 *     无人收尾,只能在封口时转(与 `cli.ts` 的 `!rule.enabled → 不处理` 同口径)。
 */
export function shouldConvertAtSeal(
  task: Pick<Task, "id" | "room" | "managedBy" | "rollingEffective">,
  hubDir: string,
): boolean {
  return sealConversionBlocker(task, hubDir) === undefined;
}

/**
 * 输出格式「锁定」原因(后端不会按所选格式处理 / 所选格式无意义);未锁 → undefined。类型见 core `OutputFormatLock`。
 *   hub-managed = worker 上的受管任务;rolling = 开了边录边传(上传后删源,互斥);
 *   hub-rule = 有 enabled 规则按房间键命中、但**不是**以本任务为源(`sourceTaskId` 缺省或指向别的任务):收尾转格式的格式
 *     只取自规则的源任务,本任务的所选格式永不生效 → 锁(T9b 回归修复);
 *   no-survivors = 本任务就是规则的源任务,且规则的清理开关使收尾后节点与 stage 都不留任何源视频(格式无处可用)。
 *
 * **与「封口是否转换」的关系(plans/036 T9b 起)**:`sourceTaskId === 本任务` 的 enabled 规则任务**封口时仍不转换**
 * (处理中途从不转),但**不锁**:改由收尾后转换(done + 清理之后对留存源分段派发 remux,见 orchestrator finalize-format)。
 * 故不变量是「锁 ⇒ 封口不转」(单向);「锁」同时覆盖「收尾也不会按本任务格式转」的全部情形。
 */
export type NodeOutputFormatLock = OutputFormatLock;
export function nodeOutputFormatLock(
  task: Pick<Task, "id" | "room" | "managedBy" | "rollingEffective">,
  hubDir: string,
): NodeOutputFormatLock | undefined {
  const b = sealConversionBlocker(task, hubDir);
  if (b === undefined) return undefined;
  if (b === "hub-managed" || b === "rolling") return b;
  // 仅按房间键命中(非源任务):收尾派发取不到本任务的格式 → 锁(与派发侧 cli 只认 sourceTaskId 同口径)。
  if (b.rule.recording?.sourceTaskId !== task.id) return "hub-rule";
  // 本任务是源任务:留存清单(与 orchestrator 清理 / 收尾转格式派发同一判定 core survivingArtifacts)里无源视频 → no-survivors。
  // 节点侧上传(与 pipeline `shouldUseNodeSideUpload` 同条件)不往 stage 放源段副本 → stagePulled=false / stageHasXmlCopy=false。
  const p = b.rule.pipeline;
  const nodeSide = !!p?.steps?.nodeSideUpload && isUploadingMode(p?.upload?.mode) && !pipelineBurns(p?.steps);
  const s = survivingArtifacts({ pipeline: { cleanup: p?.cleanup } }, { stageHasXmlCopy: !nodeSide, stagePulled: !nodeSide });
  return s.nodeSourceSegments || s.stageSourceSegments ? undefined : "no-survivors";
}

/**
 * 封口不转换的原因(无 = 转)。`shouldConvertAtSeal` 的底层,判定只此一份;`bound-rule` 携带绑定的 enabled 规则
 * (供 {@link nodeOutputFormatLock} 算 hub-rule / no-survivors)。
 */
function sealConversionBlocker(
  task: Pick<Task, "id" | "room" | "managedBy" | "rollingEffective">,
  hubDir: string,
): "hub-managed" | "rolling" | { rule: HubRule } | undefined {
  if (task.managedBy === "hub") return "hub-managed";
  if (task.rollingEffective) return "rolling";
  const platform = platformForRoom(task.room);
  const key = hubKey(platform.id, platform.extractRoomSlug(task.room));
  // 源任务规则优先于仅房间键命中的规则:任务既是某规则的源、又与另一规则同房间键时,收尾只认前者的格式。
  const enabled = listHubRules(hubDir).filter((r) => r.enabled);
  const rule = enabled.find((r) => r.recording?.sourceTaskId === task.id) ?? enabled.find((r) => r.key === key);
  return rule ? { rule } : undefined;
}

/**
 * 后台接管(**不挡录制启动**):立刻返回,接管在后台跑;整体有总时限({@link RECOVER_TOTAL_TIMEOUT_MS}),
 * 到点置放弃标记、告警并结束(未处理的配对保持原样,下次启动再接管)。单个文件的探测各自有上界,
 * 一个文件挂死(超时 → 无法判定 → 两份都保留)不影响其它文件。**永不 reject、永不抛**。
 */
export function recoverNodeRemuxInBackground(
  dir: string, fmt: StageFormat, deps: NodeRemuxDeps = {}, totalTimeoutMs: number = RECOVER_TOTAL_TIMEOUT_MS,
): Promise<RecoverSummary | undefined> {
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      aborted = true;
      const msg = `崩溃接管超过总时限 ${Math.round(totalTimeoutMs / 1000)}s,已停止(未处理的配对保持原样,两份均保留,下次启动再接管)`;
      deps.log?.(`[remux] ${msg}`);
      deps.alert?.(msg);
      resolve(undefined);
    }, totalTimeoutMs);
    timer.unref?.();
  });
  const run = recoverNodeRemux(dir, fmt, { ...deps, shouldAbort: () => aborted || (deps.shouldAbort?.() ?? false) })
    .catch((e: unknown) => { deps.log?.(`[remux] 崩溃接管失败(忽略,不影响录制): ${(e as Error)?.message ?? e}`); return undefined; });
  return Promise.race([run, limit]).finally(() => { if (timer) clearTimeout(timer); });
}
