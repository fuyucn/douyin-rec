/**
 * finalize-format — 收尾后「留存源分段」转输出格式(plans/036 §2.4 / §2.5,T9b)。
 *
 * 时点:job 已 done **且清理已完成**之后(`runPipeline` 唯一插入点),fire-and-forget,不阻塞 done、不碰上传路径。
 * 处理中途**从不**转换:规则任务在录制封口时仍按 `shouldConvertAtSeal`=false 保持原生容器,本模块只在收尾后动。
 *
 * 范围(D6):只转**源录像分段**(节点 recordings 里的 + stage 里拉来的副本),**不转**三分 P 成品(它们是已上传稿件的同一份文件,保持 mp4)。
 * 边车 `{base}.session.json` **只作为 `params.sidecar` 传入,绝不进 `inputs`**(remux 处理器自己在转换前写 `nodeFormat`;
 * 契约层也拒绝边车进 `replaceInputs`)。stage 副本缺边车 → 跳过并标注(否则转后的 mkv 在 stage 里不被 `groupSessionsInDir` 认领,#143 同类)。
 *
 * 跟随状态落 `sync_jobs.followups`(JSON):每场只派发一次(`claimFollowups` 为唯一闸门);对账轮询 `_proc-status` 回执:
 *   - `pending` 且无存活执行者持续 ≥ 60s → 告警一次,不回落、不重派(remux 不涉及不可逆外部动作,等节点 serve 起来自然续跑);
 *   - 入队回执 `stale` → 以回执 `nextGeneration` 重发**恰一次**;`rejected` 只标注不重试;
 *   - `_proc-status` 未知命令(节点已回滚旧 bundle)→ 标注「节点已回滚,留存转格式未执行」、停止轮询,**不进 needs_manual**(跟随任务,原文件未动);
 *   - 回执缺席(节点任务表无该 job)→ 终结并标注;
 *   - 入队本身失败(非「不支持」,如 ssh 抖动 / 超时)→ 该批 job 留在 open 集合(state=`enqueue-failed`,带 job / attempts / nextAt),
 *     **每节点告警一次**,由对账轮询按指数退避重入队至多 {@link MAX_ENQUEUE_RETRIES} 次;耗尽 → 终结(`failed`)并再告警一次。
 * 任何失败路径都只标注 / 告警,**绝不改 job 终态、绝不删任何文件**。
 */
import path from "node:path";
import { existsSync } from "node:fs";
import {
  jobIdOf, sessionBaseOf, STAGE_CONTAINERS, survivingArtifacts,
  type EnqueueRequest, type EnqueueResponse, type EnqueueResult, type NotifyEvent, type OutputFormat, type ProcessJob,
  type ProcessReceipt, type StageFormat,
} from "@drec/core";
import type { Broadcast } from "./identity.js";
import type { SyncLedger } from "./ledger.js";
import type { PipelineCleanup, PipelineDeps } from "./pipeline.js";
import { ProcUnsupported, type Transport } from "./transport.js";

/** stage 副本派到本机处理任务表(master 数据根);target 名固定,不会与 workerId 冲突(workerId 由 hub 配置分配)。 */
export const STAGE_TARGET = "@stage";
/** 「节点无执行者」告警的持续时长门槛(F4)。 */
export const NO_EXECUTOR_WARN_MS = 60_000;
/** 入队失败(瞬时)后由对账轮询重入队的次数上限;耗尽即放弃并告警(原文件未动)。 */
export const MAX_ENQUEUE_RETRIES = 3;
/** 重入队退避基数(ms):第 n 次重试前等 `BASE * 2^(n-1)`。 */
export const ENQUEUE_RETRY_BASE_MS = 30_000;
/** 单次 `_enqueue` 的 job 数上限(base64 走 argv,避免撞 Linux 单参数 128KiB 上限)。 */
export const ENQUEUE_CHUNK = 40;
/** remux 只受理录制原生容器。 */
const NATIVE_SOURCE_EXTS = [".ts", ".flv"];

/** 本机处理任务表通道(组合根注入;与 `_enqueue` / `_proc-status` 同一执行体)。 */
export interface StageProcChannel {
  enqueue(req: EnqueueRequest): Promise<EnqueueResponse> | EnqueueResponse;
  procStatus(jobIds: string[]): Promise<ProcessReceipt[]> | ProcessReceipt[];
}

/** `PipelineDeps.finalizeFormat`:存在 = 启用收尾后转格式;`stageProc` 缺省 → stage 副本跳过并标注。 */
export interface FinalizeFormatDeps {
  stageProc?: StageProcChannel;
}

export type FollowupState = "pending" | "running" | "done" | "failed" | "rejected" | "missing" | "rolled-back" | "enqueue-failed";
const TERMINAL_STATES: ReadonlySet<FollowupState> = new Set(["done", "failed", "rejected", "missing", "rolled-back"]);

export interface FollowupItem {
  /** workerId,或 {@link STAGE_TARGET}。 */
  target: string;
  /** 源分段 basename(展示用)。 */
  file: string;
  /** 节点回执用的最终 jobId(含节点回填的 fileTag)。 */
  jobId: string;
  generation: number;
  state: FollowupState;
  /** 首次观察到「pending 且无存活执行者」的时刻(ms);观察到执行者存活 / 非 pending 即清除。 */
  idleSince?: number;
  /** 「无执行者」告警已发(只发一次)。 */
  warned?: boolean;
  error?: string;
  /** 仅 `enqueue-failed`:待重入队的请求 job(成功入队后删除)。 */
  job?: ProcessJob;
  /** 仅 `enqueue-failed`:已失败次数(首次入队失败 = 1)。 */
  attempts?: number;
  /** 仅 `enqueue-failed`:下次可重入队的时刻(ms)。 */
  nextAt?: number;
}

/** `sync_jobs.followups` 的 JSON 形状。`open` = 仍有未终结项(对账轮询据此筛,见 `SyncLedger.listOpenFollowups`)。 */
export interface Followups {
  v: 1;
  open: boolean;
  items: FollowupItem[];
  /** 人类可读标注(去重;跳过原因 / 回滚 / 拒绝等)。 */
  notes: string[];
  /** 已就「入队失败」告警过的目标(每节点一次,首次失败时发;耗尽另发一条不受此限)。 */
  enqueueAlerted?: string[];
}

export function parseFollowups(json: string | null | undefined): Followups | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Followups;
    return v && v.v === 1 && Array.isArray(v.items) && Array.isArray(v.notes) ? v : null;
  } catch { return null; }
}

const serialize = (f: Followups): string => JSON.stringify({ ...f, open: f.items.some((i) => !TERMINAL_STATES.has(i.state)) });

// ───────────────────────── 规划(纯函数 + 只读磁盘) ─────────────────────────

export interface PlannedRemux {
  target: string;
  /** generation=1 的请求 job(logicalKey 以 `@` 结尾,fileTag 由执行节点回填)。 */
  job: ProcessJob;
}

export interface SurvivorPlan {
  jobs: PlannedRemux[];
  notes: string[];
}

const extOf = (p: string): string => path.extname(p).toLowerCase();

function mkJob(streamKey: string, target: string, file: string, sidecar: string, fmt: StageFormat, createdAt: number): ProcessJob {
  const logicalKey = `finalize:${streamKey}:${target}:${path.posix.basename(file.replace(/\\/g, "/"))}@`;
  const out = `${file.slice(0, file.length - extOf(file).length)}${STAGE_CONTAINERS[fmt].ext}`;
  return {
    jobId: jobIdOf("remux", logicalKey, 1), kind: "remux", logicalKey, generation: 1,
    inputs: [file], outputs: [out],
    // sidecar 只在 params:remux 处理器在同目录会话边车写 nodeFormat;它绝不进 inputs / replaceInputs。
    params: { format: fmt, owner: "hub", sidecar },
    replaceInputs: true, owner: { streamKey }, createdAt,
  };
}

/**
 * 算「收尾后需要转格式的留存源分段」。判定唯一来源 = core `survivingArtifacts`(清理开关会不会删)+ 磁盘实际存在(stage)。
 * 只转容器与所选格式不一致的**源分段**;不转三分 P、xml/ass、边车。
 */
export function planSurvivorRemux(o: {
  streamKey: string;
  outputFormat: OutputFormat | undefined;
  cleanup: PipelineCleanup | undefined;
  members: Broadcast["members"];
  stageSub: string;
  /** 源段是否被拉进 stage(节点侧上传为 false)。 */
  stagePulled: boolean;
  /** 本机是否能受理 stage 副本(`stageProc` 已注入)。 */
  hasStageProc: boolean;
  exists?: (p: string) => boolean;
  now?: number;
}): SurvivorPlan {
  const plan: SurvivorPlan = { jobs: [], notes: [] };
  const fmt = o.outputFormat;
  if (!fmt || fmt === "original") return plan;
  const exists = o.exists ?? existsSync;
  const createdAt = o.now ?? Date.now();
  const note = (s: string): void => { if (!plan.notes.includes(s)) plan.notes.push(s); };
  const surv = survivingArtifacts({ pipeline: { cleanup: o.cleanup } }, { stageHasXmlCopy: o.stagePulled, stagePulled: o.stagePulled });
  const convertible = (f: string): boolean => NATIVE_SOURCE_EXTS.includes(extOf(f));

  // ① 节点源分段(派到该节点;sourceAfterDone 开则已被清理,无留存)。
  if (surv.nodeSourceSegments) {
    for (const m of o.members) {
      if (m.rec.rolling) continue; // 边录边传的会话:节点自己已上传/删段,master 不碰
      for (const f of m.rec.tsFiles.filter(convertible)) {
        if (!path.posix.isAbsolute(f)) { note(`节点 ${m.workerId} 的分段路径非绝对路径,跳过转格式: ${path.posix.basename(f)}`); continue; }
        const expected = path.posix.join(path.posix.dirname(f), `${sessionBaseOf(f)}.session.json`);
        if (!m.rec.sessionJsonPath) { note(`节点 ${m.workerId} 缺会话边车,跳过转格式: ${sessionBaseOf(f)}`); continue; }
        // 处理器按分段名推导同目录边车;清单里的边车位置与之不一致 = 无法保证转换后会话仍被认领 → 不转。
        if (m.rec.sessionJsonPath !== expected) { note(`节点 ${m.workerId} 的会话边车位置与分段不一致,跳过转格式: ${sessionBaseOf(f)}`); continue; }
        plan.jobs.push({ target: m.workerId, job: mkJob(o.streamKey, m.workerId, f, expected, fmt, createdAt) });
      }
    }
  }

  // ② stage 里拉来的源段副本(派到本机)。以磁盘上存在为准;同名副本只算一份。
  if (surv.stageSourceSegments) {
    const seen = new Set<string>();
    for (const m of o.members) {
      for (const f of m.rec.tsFiles.filter(convertible)) {
        const name = path.posix.basename(f.replace(/\\/g, "/"));
        const p = path.join(o.stageSub, name);
        if (seen.has(p) || !exists(p)) continue;
        seen.add(p);
        if (!o.hasStageProc) { note("本机未注入处理任务表通道,stage 副本跳过转格式"); continue; }
        const sidecar = path.join(o.stageSub, `${sessionBaseOf(p)}.session.json`);
        if (!exists(sidecar)) { note(`stage 副本缺会话边车,跳过转格式: ${sessionBaseOf(p)}`); continue; }
        plan.jobs.push({ target: STAGE_TARGET, job: mkJob(o.streamKey, STAGE_TARGET, p, sidecar, fmt, createdAt) });
      }
    }
  }
  return plan;
}

// ───────────────────────── 派发 ─────────────────────────

const msgOf = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

async function enqueueVia(
  target: string, transports: Map<string, Transport>, stageProc: StageProcChannel | undefined, req: EnqueueRequest,
): Promise<EnqueueResponse> {
  if (target === STAGE_TARGET) {
    if (!stageProc) throw new ProcUnsupported("本机未注入处理任务表通道");
    return await stageProc.enqueue(req);
  }
  const t = transports.get(target);
  if (!t?.enqueue) throw new ProcUnsupported(t ? "transport 不支持处理任务表入队" : "节点已不在 hub 配置中");
  return await t.enqueue(req);
}

function itemOf(target: string, job: ProcessJob, r: EnqueueResult, generation: number): FollowupItem {
  const base: FollowupItem = { target, file: path.basename(job.inputs[0]), jobId: r.jobId, generation, state: "pending" };
  if (r.state === "running") base.state = "running";
  else if (r.state === "done") base.state = "done";
  else if (r.state === "rejected" || r.state === "stale") { base.state = "rejected"; if (r.error) base.error = r.error; }
  return base;
}

const labelOf = (target: string): string => (target === STAGE_TARGET ? "本机 stage" : `节点 ${target}`);

/** 入队一批(≤ {@link ENQUEUE_CHUNK})并处理 stale 重发恰一次;传输 / 回执异常原样抛出(由调用方分类)。 */
async function enqueueChunk(
  target: string, chunk: ProcessJob[], transports: Map<string, Transport>, stageProc: StageProcChannel | undefined,
  noteOnce: (s: string) => void,
): Promise<FollowupItem[]> {
  const items: FollowupItem[] = [];
  const res = await enqueueVia(target, transports, stageProc, { v: 1, jobs: chunk });
  if (!Array.isArray(res?.results) || res.results.length !== chunk.length) throw new Error("入队回执条数与请求不符");
  const resend: ProcessJob[] = [];
  res.results.forEach((r, idx) => {
    if (r.state === "stale" && r.nextGeneration) {
      // 同 jobId 已 done 但产物已不在:以节点算出的下一代**重发一次**(N1)。
      const prev = chunk[idx];
      resend.push({ ...prev, generation: r.nextGeneration, jobId: jobIdOf("remux", prev.logicalKey, r.nextGeneration) });
    } else items.push(itemOf(target, chunk[idx], r, chunk[idx].generation));
  });
  if (resend.length > 0) {
    const again = await enqueueVia(target, transports, stageProc, { v: 1, jobs: resend });
    resend.forEach((job, k) => {
      const r = again.results?.[k];
      if (!r) { noteOnce(`${labelOf(target)} 重发回执缺失: ${path.basename(job.inputs[0])}`); return; }
      const item = itemOf(target, job, r, job.generation);
      if (r.state === "stale") { item.state = "rejected"; item.error = "重发一次后仍 stale,不再重试"; }
      items.push(item);
    });
  }
  return items;
}

/** 入队失败项:留在 open 集合,等对账轮询退避重入队。 */
function failedItem(target: string, job: ProcessJob, e: unknown, now: number): FollowupItem {
  return {
    target, file: path.basename(job.inputs[0]), jobId: job.jobId, generation: job.generation, state: "enqueue-failed",
    job, attempts: 1, nextAt: now + ENQUEUE_RETRY_BASE_MS, error: msgOf(e),
  };
}

/** 本进程正在派发的场(done 场收尾补跑重入 runPipeline 时,避免与上一次尚未写完 followups 的派发重叠)。 */
const dispatching = new Set<string>();
/** 仅测试:清空进程内在途集合(入队永不返回的用例会让该 key 一直占位)。 */
export function _resetFinalizeFormatState(): void { dispatching.clear(); }

/**
 * 派发并记账。每场只做一次:`ledger.claimFollowups` 失败(已认领)即返回。**永不抛**:任何异常只标注 + 写日志。
 */
export async function dispatchSurvivorRemux(o: {
  streamKey: string;
  plan: SurvivorPlan;
  transports: Map<string, Transport>;
  stageProc?: StageProcChannel;
  ledger: SyncLedger;
  log: (msg: string) => void;
  notify?: (e: NotifyEvent) => void;
  now?: () => number;
}): Promise<Followups | null> {
  const { streamKey, plan, ledger, log } = o;
  if (dispatching.has(streamKey)) return null;
  dispatching.add(streamKey);
  try {
    const fu: Followups = { v: 1, open: true, items: [], notes: [...plan.notes] };
    if (!ledger.claimFollowups(streamKey, serialize(fu))) return null; // 已派发过
    const noteOnce = (s: string): void => { if (!fu.notes.includes(s)) fu.notes.push(s); };

    const byTarget = new Map<string, ProcessJob[]>();
    for (const { target, job } of plan.jobs) byTarget.set(target, [...(byTarget.get(target) ?? []), job]);

    for (const [target, jobs] of byTarget) {
      const label = labelOf(target);
      for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
        const chunk = jobs.slice(i, i + ENQUEUE_CHUNK);
        try {
          fu.items.push(...await enqueueChunk(target, chunk, o.transports, o.stageProc, noteOnce));
        } catch (e) {
          if (e instanceof ProcUnsupported) {
            noteOnce(`${label} 不支持处理任务表(旧版本),留存转格式跳过`);
            break; // 该目标其余批次同样不支持
          }
          // 瞬时失败(ssh 抖动 / 超时等):本批及该目标其余批次留在 open 集合,由对账轮询退避重入队;每节点告警一次。
          const at = (o.now ?? Date.now)();
          for (const j of jobs.slice(i)) fu.items.push(failedItem(target, j, e, at));
          noteOnce(`${label} 留存转格式入队失败,稍后重试(最多 ${MAX_ENQUEUE_RETRIES} 次): ${msgOf(e)}`);
          fu.enqueueAlerted = [...(fu.enqueueAlerted ?? []), target];
          o.notify?.({ kind: "error", stage: "同步", message: `${streamKey} ${label} 留存转格式入队失败(${jobs.length - i} 段),将自动重试: ${msgOf(e)}` });
          break;
        }
      }
    }
    for (const it of fu.items) {
      if (it.state === "rejected") noteOnce(`${labelOf(it.target)} 拒绝转格式 ${it.file}: ${it.error ?? "未知"}`);
    }
    ledger.setFollowups(streamKey, serialize(fu));
    for (const n of fu.notes) log(`留存转格式: ${n}`);
    log(`留存转格式: 已派发 ${fu.items.length} 段(${fu.items.filter((i) => !TERMINAL_STATES.has(i.state)).length} 待执行)`);
    return fu;
  } catch (e) {
    log(`留存转格式派发异常(忽略,不影响 done): ${msgOf(e)}`);
    return null;
  } finally {
    dispatching.delete(streamKey);
  }
}

/**
 * `runPipeline` 的收尾插入点:job 已 done 且清理已完成后调用。**同步返回一个永不 reject 的 promise,调用方不 await**
 * (fire-and-forget;不阻塞 done / 上传)。未注入 `deps.finalizeFormat` 或输出格式为 original → 什么都不做。
 */
export function launchFinalizeFormat(o: {
  b: Broadcast;
  deps: PipelineDeps;
  stageSub: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { b, deps, log } = o;
  const ff = deps.finalizeFormat;
  const fmt = deps.cfg.outputFormat;
  if (!ff || !fmt || fmt === "original") return Promise.resolve();
  return (async (): Promise<void> => {
    try {
      if (dispatching.has(b.streamKey) || deps.ledger.getFollowups(b.streamKey) !== null) return;
      const stagePulled = deps.ledger.getNodeState(b.streamKey, "node_upload")?.state !== "done";
      const plan = planSurvivorRemux({
        streamKey: b.streamKey, outputFormat: fmt, cleanup: deps.cfg.cleanup, members: b.members,
        stageSub: o.stageSub, stagePulled, hasStageProc: !!ff.stageProc,
      });
      await dispatchSurvivorRemux({
        streamKey: b.streamKey, plan, transports: deps.transports, stageProc: ff.stageProc, ledger: deps.ledger, log, notify: deps.notify,
      });
    } catch (e) {
      log(`留存转格式异常(忽略,不影响 done): ${msgOf(e)}`);
    }
  })();
}

// ───────────────────────── 对账轮询 ─────────────────────────

/**
 * 对账期轮询跟随项的回执(reconciler 每轮调一次)。**永不抛**:单目标失败(不可达等)只跳过本轮,下轮再来。
 * 只写 followups 与告警,不碰 job 状态。
 */
export async function pollFollowups(o: {
  ledger: SyncLedger;
  transports: Map<string, Transport>;
  stageProc?: StageProcChannel;
  notify?: (e: NotifyEvent) => void;
  log?: (msg: string) => void;
  now?: () => number;
}): Promise<void> {
  const now = o.now ?? Date.now;
  for (const row of o.ledger.listOpenFollowups()) {
    try {
      const fu = parseFollowups(row.followups);
      if (!fu) continue;
      let changed = false;
      // 入队失败项:到期则退避重入队(成功 → 转为 pending 项并随后与其它项一起查回执;耗尽 → 终结 + 告警)。
      if (await retryEnqueueFailed(fu, o, now())) changed = true;
      const open = fu.items.filter((i) => !TERMINAL_STATES.has(i.state) && i.state !== "enqueue-failed");
      const targets = [...new Set(open.map((i) => i.target))];
      for (const target of targets) {
        const items = open.filter((i) => i.target === target);
        const label = labelOf(target);
        let receipts: ProcessReceipt[];
        try {
          if (target === STAGE_TARGET) {
            if (!o.stageProc) throw new ProcUnsupported("本机未注入处理任务表通道");
            receipts = await o.stageProc.procStatus(items.map((i) => i.jobId));
          } else {
            const t = o.transports.get(target);
            if (!t) continue; // 节点暂不在当前 hub 配置里:保持开放,下轮再看
            if (!t.procStatus) throw new ProcUnsupported("transport 不支持回执查询");
            receipts = await t.procStatus(items.map((i) => i.jobId));
          }
        } catch (e) {
          if (e instanceof ProcUnsupported) {
            // 节点入队后回滚旧 bundle(N7):标注、停止轮询、**不进 needs_manual**(跟随任务,原文件未动)。
            for (const it of items) it.state = "rolled-back";
            const n = `${label} 已回滚,留存转格式未执行`;
            if (!fu.notes.includes(n)) fu.notes.push(n);
            o.log?.(`[finalize-format] ${row.streamKey} ${n}`);
            changed = true;
          }
          continue; // 其它错误(不可达等):本轮跳过
        }
        const byId = new Map(receipts.map((r) => [r.jobId, r]));
        const due: FollowupItem[] = [];
        const failedNow: FollowupItem[] = [];
        for (const it of items) {
          const r = byId.get(it.jobId);
          if (!r) {
            it.state = "missing";
            const n = `${label} 回执缺席(节点任务表无该 job): ${it.file}`;
            if (!fu.notes.includes(n)) fu.notes.push(n);
            changed = true;
            continue;
          }
          if (r.state === "done") { it.state = "done"; delete it.idleSince; changed = true; continue; }
          if (r.state === "failed" || r.state === "uncertain" || r.state === "cancelled") {
            it.state = "failed";
            if (r.error) it.error = r.error;
            const n = `${label} 转格式未完成(${r.state}): ${it.file}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`;
            if (!fu.notes.includes(n)) fu.notes.push(n);
            failedNow.push(it);
            changed = true;
            continue;
          }
          if (r.state === "running") { if (it.state !== "running" || it.idleSince !== undefined) { it.state = "running"; delete it.idleSince; changed = true; } continue; }
          // pending
          if (r.leaseAlive) { if (it.idleSince !== undefined) { delete it.idleSince; changed = true; } continue; }
          if (it.idleSince === undefined) { it.idleSince = now(); changed = true; continue; }
          if (!it.warned && now() - it.idleSince >= NO_EXECUTOR_WARN_MS) { it.warned = true; changed = true; due.push(it); }
        }
        // 节点任务终态失败:节点 runner 的告警按 taskId 路由,hub 派发的 job 没有 taskId,这里补一条(原文件保留,可人工重转)。
        if (failedNow.length > 0) {
          const msg = `${row.streamKey} ${label} 留存转格式失败(${failedNow.length} 段),原文件已保留`;
          o.log?.(`[finalize-format] ${msg}`);
          o.notify?.({ kind: "error", stage: "同步", message: msg });
        }
        // 同一目标的多段合并成一条告警(每目标只发一次,不按段刷屏)。
        if (due.length > 0) {
          const msg = `${row.streamKey} ${label} 无存活执行者,留存转格式(${due.length} 段)待节点 serve 恢复后自动执行`;
          o.log?.(`[finalize-format] ${msg}`);
          o.notify?.({ kind: "error", stage: "同步", message: msg });
        }
      }
      if (changed) o.ledger.setFollowups(row.streamKey, serialize(fu));
    } catch (e) {
      o.log?.(`[finalize-format] 轮询 ${row.streamKey} 异常(忽略): ${msgOf(e)}`);
    }
  }
}

/**
 * 对「入队失败」项到期重入队(同目标的到期项合成批)。返回是否改动了 `fu`。永不抛。
 * 失败 → attempts+1、指数退避;attempts 达 {@link MAX_ENQUEUE_RETRIES}+1(= 首次 + 3 次重试均失败)→ 终结为 `failed` 并按节点告警一次。
 */
async function retryEnqueueFailed(
  fu: Followups,
  o: { transports: Map<string, Transport>; stageProc?: StageProcChannel; notify?: (e: NotifyEvent) => void; log?: (msg: string) => void },
  at: number,
): Promise<boolean> {
  const pending = fu.items.filter((i) => i.state === "enqueue-failed" && i.job && (i.nextAt ?? 0) <= at);
  if (pending.length === 0) return false;
  const noteOnce = (n: string): void => { if (!fu.notes.includes(n)) fu.notes.push(n); };
  const exhausted = new Map<string, FollowupItem[]>();
  for (const target of [...new Set(pending.map((i) => i.target))]) {
    const label = labelOf(target);
    const mine = pending.filter((i) => i.target === target);
    for (let k = 0; k < mine.length; k += ENQUEUE_CHUNK) {
      const batch = mine.slice(k, k + ENQUEUE_CHUNK);
      try {
        const got = await enqueueChunk(target, batch.map((i) => i.job as ProcessJob), o.transports, o.stageProc, noteOnce);
        // 成功:以回执项替换失败项(stale 重发可能改 jobId / generation,回执项已带最终值)。
        fu.items = fu.items.filter((i) => !batch.includes(i));
        fu.items.push(...got);
      } catch (e) {
        if (e instanceof ProcUnsupported) {
          for (const it of batch) { it.state = "rolled-back"; delete it.job; }
          noteOnce(`${label} 不支持处理任务表(旧版本),留存转格式跳过`);
          continue;
        }
        for (const it of batch) {
          it.attempts = (it.attempts ?? 1) + 1;
          it.error = msgOf(e);
          if (it.attempts >= MAX_ENQUEUE_RETRIES + 1) {
            it.state = "failed";
            delete it.job;
            exhausted.set(target, [...(exhausted.get(target) ?? []), it]);
          } else it.nextAt = at + ENQUEUE_RETRY_BASE_MS * 2 ** ((it.attempts ?? 2) - 1);
        }
      }
    }
  }
  for (const [target, its] of exhausted) {
    const label = labelOf(target);
    const msg = `${label} 留存转格式入队重试 ${MAX_ENQUEUE_RETRIES} 次仍失败,已放弃(${its.length} 段,原文件已保留): ${its[0].error ?? ""}`;
    noteOnce(msg);
    o.log?.(`[finalize-format] ${msg}`);
    o.notify?.({ kind: "error", stage: "同步", message: msg });
  }
  return true;
}
