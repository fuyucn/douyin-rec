/**
 * core/processor.ts — 后处理「处理器」一等抽象:契约 + 注册表 + jobId 约定 + 任务状态机(plans/036 §2.1)。
 *
 * 纯类型 + 纯函数 + 模块级注册表,无 I/O、无调用方(T1 只立契约;任务表 `@drec/proc-queue` 与具体处理器
 * `@drec/processors` 在后续任务)。形态对齐 `platform.ts` / `engine.ts`:模块级 `Map`、重复注册抛错、
 * `_reset*` 仅测试用。
 *
 * 唯一真理源:全仓只此一处拼/拆 jobId(`jobIdOf`/`parseJobId`)、只此一份状态迁移表(`PROC_TRANSITIONS`)、
 * 只此一处判定 job 路径合法性(`assertJobInvariants`)。
 */

import { isAbsolute, relative, resolve } from "node:path";
import { isVideoFileName } from "./output-format.js";

export type ResourceClass = "cpu" | "net" | "upload";

export interface ProcessJob {
  /** = jobIdOf(kind, logicalKey, generation);派发方给定、确定性 → 幂等。 */
  jobId: string;
  /** 第一期只有 "remux";第二期 "merge" | "burn" | "biliup"。 */
  kind: string;
  /** 逻辑键(同一逻辑工作单元跨重派不变),约定见 plans/036 §2.1。 */
  logicalKey: string;
  /** 从 1 起;只由「stale 重派」或人工重试递增。 */
  generation: number;
  /** 绝对路径,显式列出;处理器不得扫目录。 */
  inputs: string[];
  /** 期望产物(merge/burn 必填;remux 由 params.format 推出)。 */
  outputs?: string[];
  params: Record<string, unknown>;
  /** true = 校验通过后删除 inputs(只允许视频扩展名,拒 xml/ass/会话边车)。 */
  replaceInputs: boolean;
  owner: { taskId?: number; streamKey?: string };
  createdAt: number;
  /** plan 038: 同一场共享的保序键(remux 等无保序需求时为 null/缺省)。 */
  orderKey?: string | null;
  /** plan 038: 场内序号(1 起);orderKey 为空时无意义。 */
  seq?: number | null;
  /** plan 038: 不早于该 epoch ms 才可认领。 */
  notBefore?: number | null;
  /** plan 038: biliup 行依赖的 upload-prep jobId。 */
  prepJobId?: string | null;
}

/** 处理器运行期上下文(由 runner 注入;处理器只经它感知租约/取消,不直接碰任务表)。 */
export interface ProcessContext {
  /** 取消/关停信号(interruptible 处理器应响应并清理临时文件)。 */
  signal: AbortSignal;
  /** 租约已丢(被接管/fencing)时抛错;处理器在删 inputs 等不可逆动作前必须调用。 */
  assertLease(): void;
  /** 上报进度(喂租约心跳 / 卡死看门狗)。 */
  markProgress(): void;
  log(msg: string): void;
  /**
   * 告警回调(recover 判 uncertain、磁盘不足、校验失败等须让人看见的事件;不等同于 `log`)。
   * proc-queue 不依赖 observability(0.5),故告警经此回调注入;**按 `job.owner.taskId` 路由到该任务的
   * 通知/事件中心由 runner 负责**(plans/036 §2.2 / §2.3),处理器只管调用。
   */
  alert(msg: string): void;
  /** Persist observable progress fields (step / bv / child pid). Processor never touches the store. */
  setState?(patch: { step?: string | null; bv?: string | null; childPid?: number | null; childPidStartedAt?: string | null }): void;
}

export interface ProcessResult {
  /** 实际产物绝对路径。 */
  outputs: string[];
  /** 人类可读备注(入表 / 展示)。 */
  note?: string;
  /** BV created by this run (biliup). */
  bv?: string;
  /** Ask the runner to retry later (transfer failure with a confirmed stopped child). */
  retry?: { notBefore: number; reason: "transfer-retry" };
}

export interface Processor {
  kind: string;
  resource: ResourceClass;
  /** 同资源类内的独立通道:remux = "copy",不与烧录抢 cpu 槽。 */
  lane?: string;
  /** biliup = false。 */
  retryable: boolean;
  /** 关停时可直接 abort 回 pending(remux/merge/burn = true;biliup = false)。 */
  interruptible: boolean;
  /** 返回 null = 合法;否则返回拒绝原因。 */
  validate(job: ProcessJob): string | null;
  estimateDiskBytes(job: ProcessJob): number;
  run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult>;
  /** 接管中断的 running job 时判定:重跑 / 已完成 / 无法判定(→ uncertain)。 */
  recover?(job: ProcessJob, ctx: ProcessContext): Promise<"rerun" | "done" | "uncertain">;
  /** Shutdown verification: may this running row safely return to pending? */
  verifyStopped?(job: ProcessJob, ctx: ProcessContext): Promise<"safe" | "uncertain">;
}

// ───────────────────────── 注册表 ─────────────────────────

const processors = new Map<string, Processor>();

/** 注册处理器;同 kind 重复注册抛错(静默覆盖会让两份实现悄悄互换)。 */
export function registerProcessor(p: Processor): void {
  if (processors.has(p.kind)) throw new Error(`[processor] kind 已注册: ${p.kind}`);
  processors.set(p.kind, p);
}

export function getProcessor(kind: string): Processor | undefined {
  return processors.get(kind);
}

export function listProcessors(): Processor[] {
  return [...processors.values()];
}

/** 仅供测试:清空注册表。 */
export function _resetProcessors(): void {
  processors.clear();
}

// ───────────────────────── jobId ─────────────────────────

const KIND_RE = /^[a-z][a-z0-9-]*$/;
const GENERATION_MARK = "#g";

/** `${kind}:${logicalKey}#g${generation}`。全仓唯一拼接点;非法入参抛错(不产出无法被 parse 的 id)。 */
export function jobIdOf(kind: string, logicalKey: string, generation: number): string {
  if (!KIND_RE.test(kind)) throw new Error(`[processor] 非法 kind: ${JSON.stringify(kind)}`);
  if (logicalKey === "") throw new Error("[processor] logicalKey 不能为空");
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`[processor] generation 须为 ≥1 的整数: ${generation}`);
  }
  return `${kind}:${logicalKey}${GENERATION_MARK}${generation}`;
}

/**
 * `jobIdOf` 的逆。kind 取首个 `:` 之前、generation 取**最后**一个 `#g` 之后,
 * 因此 logicalKey 内可含 `:` / `#`(如 streamKey、fileTag)。格式不符返回 null。
 */
export function parseJobId(jobId: string): { kind: string; logicalKey: string; generation: number } | null {
  const colon = jobId.indexOf(":");
  const mark = jobId.lastIndexOf(GENERATION_MARK);
  if (colon < 0 || mark <= colon + 1) return null;
  const kind = jobId.slice(0, colon);
  const genText = jobId.slice(mark + GENERATION_MARK.length);
  if (!KIND_RE.test(kind) || !/^[1-9]\d*$/.test(genText)) return null;
  const generation = Number(genText);
  if (!Number.isSafeInteger(generation)) return null;
  return { kind, logicalKey: jobId.slice(colon + 1, mark), generation };
}

// ───────────────────────── 契约不变量 ─────────────────────────

/**
 * p 是否严格位于 root 之下(纯字符串口径,先 resolve 消掉 `..`;**不跟符号链接**——
 * `<root>/link -> /etc` 下的路径会被放行,节点侧(plans/036 T9a)须另做 realpath 校验)。
 */
function isUnderRoot(p: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/**
 * 校验 job 的契约不变量,违反则抛错(拒绝入队/执行):
 * - jobId 须可 parse 且与 kind/logicalKey/generation 一致;
 * - inputs 非空,inputs/outputs 全部是绝对路径(无 NUL);
 * - `replaceInputs` 时 inputs 必须全是视频扩展名(拒 xml/ass/会话边车 —— 不可再生);
 * - `replaceInputs` 时 outputs 与 inputs 不得重叠(否则「删原文件」会删掉产物);
 * - 任一路径不在 `allowedRoots` 之下(空 allowedRoots = 全拒,fail-closed)。
 *
 * `allowedRoots` 必须是绝对路径:空串与相对路径一律忽略(不按 cwd 解析,同一配置判定不随 cwd 变),
 * 全被忽略即全拒。`"/"` 会放行全盘,由构造方(T9a)保证不传。
 */
export function assertJobInvariants(job: ProcessJob, opts: { allowedRoots: readonly string[] }): void {
  const bad = (why: string): never => {
    throw new Error(`[processor] job 违反契约 (${job.jobId}): ${why}`);
  };
  const parsed = parseJobId(job.jobId);
  if (!parsed) bad("jobId 格式非法");
  else if (parsed.kind !== job.kind || parsed.logicalKey !== job.logicalKey || parsed.generation !== job.generation) {
    bad("jobId 与 kind/logicalKey/generation 不一致");
  }
  if (!Array.isArray(job.inputs) || job.inputs.length === 0) bad("inputs 为空");
  const paths = [...job.inputs, ...(job.outputs ?? [])];
  for (const p of paths) {
    if (typeof p !== "string" || p === "" || p.includes("\0")) bad("路径非法");
    if (!isAbsolute(p)) bad(`路径须为绝对路径: ${p}`);
  }
  if (job.replaceInputs) {
    for (const p of job.inputs) {
      if (!isVideoFileName(p)) bad(`replaceInputs 只允许视频扩展名(拒 xml/ass/边车): ${p}`);
    }
  }
  if (job.replaceInputs && job.outputs) {
    const ins = new Set(job.inputs.map((p) => resolve(p)));
    for (const o of job.outputs) {
      if (ins.has(resolve(o))) bad(`replaceInputs 时 outputs 不得与 inputs 重叠: ${o}`);
    }
  }
  const roots = opts.allowedRoots.filter((r) => isAbsolute(r));
  for (const p of paths) {
    if (!roots.some((r) => isUnderRoot(p, r))) bad(`路径不在 allowedRoots 内: ${p}`);
  }
}

// ───────────────────────── 状态机 ─────────────────────────

export type JobState = "pending" | "running" | "done" | "failed" | "uncertain" | "cancelled";

/**
 * 合法迁移**边集**(必要条件)。带条件的边还须过 `canTransition`:
 * - pending → cancelled:仅从未被认领;
 * - running → pending:仅租约过期且 recover()=rerun,或关停时 interruptible job 被 abort;
 * - failed → pending:只经 requeue;
 * - uncertain → failed:人工 ackUncertain(uncertain 不可直接回 pending/done);
 * - done / cancelled 终态。
 */
export const PROC_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
  pending: Object.freeze(["running", "cancelled"] as const),
  running: Object.freeze(["done", "failed", "uncertain", "cancelled", "pending"] as const),
  failed: Object.freeze(["pending"] as const),
  uncertain: Object.freeze(["failed"] as const),
  done: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
});

export type TransitionReason =
  | "lease-expired-rerun" // 租约过期 + recover()=rerun
  | "shutdown-abort" // 关停时 interruptible job 被 abort
  | "requeue" // failed → pending
  | "ack-uncertain" // uncertain → failed
  | "transfer-retry" // running → pending after a failed/stalled transfer (child confirmed stopped)
  | "order-blocked"; // cascade cancel of later seq rows in the same generation

export interface TransitionContext {
  /** pending → cancelled 的前提:该行从未被认领(原子条件更新由 store 保证)。 */
  neverClaimed?: boolean;
  reason?: TransitionReason;
  /** reason=shutdown-abort 时,job 的处理器是否 interruptible。 */
  interruptible?: boolean;
  /** plan 038: transfer-retry 只允许 biliup 在 gate_wait/transfer 阶段、且子进程已确认停止。 */
  kind?: string;
  step?: string | null;
  childConfirmedStopped?: boolean;
}

/**
 * 迁移是否合法(边在表内 + 条件满足);缺条件一律 false(fail-closed)。
 *
 * ⚠️ 本函数**不**执行「biliup 已写 intent → uncertain」:`running → cancelled` 无条件放行。
 * store 的 `finish(cancelled)` 必须先经 `cancelOutcome(kind, hasIntent)` 判定落点,
 * 结果为 `uncertain` 时走 running → uncertain(第二期 T15 落地 biliup 时在 store 里强制,plans/036)。
 */
export function canTransition(from: JobState, to: JobState, ctx: TransitionContext = {}): boolean {
  if (!PROC_TRANSITIONS[from].includes(to)) return false;
  if (from === "pending" && to === "cancelled") return ctx.neverClaimed === true;
  if (from === "running" && to === "pending") {
    if (ctx.reason === "transfer-retry") {
      return ctx.kind === "biliup" && (ctx.step === "gate_wait" || ctx.step === "transfer") && ctx.childConfirmedStopped === true;
    }
    return ctx.reason === "lease-expired-rerun" || (ctx.reason === "shutdown-abort" && ctx.interruptible === true);
  }
  if (from === "failed" && to === "pending") return ctx.reason === "requeue";
  if (from === "uncertain" && to === "failed") return ctx.reason === "ack-uncertain";
  return true;
}

/**
 * 取消落在哪个终态:biliup 写 intent(已发起不可逆外部动作)之后被取消 → `uncertain`(须人工确认,
 * 防二次建稿);其余 → `cancelled`。
 */
export function cancelOutcome(kind: string, hasIntent: boolean): "cancelled" | "uncertain" {
  return kind === "biliup" && hasIntent ? "uncertain" : "cancelled";
}

// ───────────────────────── 派发 / 回执 ─────────────────────────

/** `_enqueue <dataRoot> <base64>` 的请求体。 */
export interface EnqueueRequest {
  v: 1;
  jobs: ProcessJob[];
}

export type EnqueueState = "pending" | "running" | "done" | "stale" | "rejected";

export interface EnqueueResult {
  jobId: string;
  state: EnqueueState;
  /** 仅 state=stale:节点 store 算出的下一代,派发方原样以此作 generation 重发(N1)。 */
  nextGeneration?: number;
  /** state=rejected 时的原因(可选,供标注)。 */
  error?: string;
  /** 仅 state=rejected 且因「同 jobId 已有终态行」被拒:该行现态。入队方据此区分「须人工处理」与契约/stat 失败(后者可回落)。 */
  existingState?: "failed" | "uncertain" | "cancelled";
}

/** `_enqueue` 的单行 JSON 响应。 */
export interface EnqueueResponse {
  v: 1;
  results: EnqueueResult[];
}

/** `_proc-status` 回执。 */
export interface ProcessReceipt {
  jobId: string;
  state: JobState;
  error?: string;
  /** 持有租约的执行者是否存活(master 据此判「节点无执行者」)。 */
  leaseAlive: boolean;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function decodeJob(raw: unknown, i: number): ProcessJob {
  const bad = (why: string): never => {
    throw new Error(`[processor] EnqueueRequest.jobs[${i}] ${why}`);
  };
  if (!isRecord(raw)) return bad("不是对象");
  const strArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
  if (typeof raw.jobId !== "string" || typeof raw.kind !== "string" || typeof raw.logicalKey !== "string") {
    return bad("jobId/kind/logicalKey 须为字符串");
  }
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1) return bad("generation 非法");
  if (!strArr(raw.inputs)) return bad("inputs 须为字符串数组");
  if (raw.outputs !== undefined && !strArr(raw.outputs)) return bad("outputs 须为字符串数组");
  if (!isRecord(raw.params)) return bad("params 须为对象");
  if (typeof raw.replaceInputs !== "boolean") return bad("replaceInputs 须为布尔");
  if (!isRecord(raw.owner)) return bad("owner 须为对象");
  const { taskId, streamKey } = raw.owner;
  if (taskId !== undefined && !Number.isSafeInteger(taskId)) return bad("owner.taskId 须为整数");
  if (streamKey !== undefined && typeof streamKey !== "string") return bad("owner.streamKey 须为字符串");
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return bad("createdAt 非法");
  // 白名单重建:未知字段不透传(防被原样序列化进 params/行 JSON)。
  const job: ProcessJob = {
    jobId: raw.jobId,
    kind: raw.kind,
    logicalKey: raw.logicalKey,
    generation: raw.generation as number,
    inputs: raw.inputs,
    params: raw.params,
    replaceInputs: raw.replaceInputs,
    owner: {
      ...(taskId !== undefined ? { taskId: taskId as number } : {}),
      ...(streamKey !== undefined ? { streamKey: streamKey as string } : {}),
    },
    createdAt: raw.createdAt,
  };
  if (raw.outputs !== undefined) job.outputs = raw.outputs;
  return job;
}

/** 编码 `EnqueueRequest` 为 base64(`_enqueue` 命令行参数)。 */
export function encodeEnqueue(req: EnqueueRequest): string {
  return Buffer.from(JSON.stringify(req), "utf8").toString("base64");
}

/** 解码 + 校验 `_enqueue` 的 base64 参数;v≠1 / 结构非法 / 非 JSON 一律抛错(不静默当空请求)。 */
export function decodeEnqueue(b64: string): EnqueueRequest {
  let parsed: unknown;
  try {
    const buf = Buffer.from(b64, "base64");
    // 往返校验:Buffer 对非法字符/尾部垃圾静默容错,此处拒绝(忽略填充差异)。
    if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) throw new Error("非法 base64");
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw new Error(`[processor] EnqueueRequest 无法解码: ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error("[processor] EnqueueRequest 不是对象");
  if (parsed.v !== 1) throw new Error(`[processor] 不支持的 EnqueueRequest 版本: ${String(parsed.v)}`);
  if (!Array.isArray(parsed.jobs)) throw new Error("[processor] EnqueueRequest.jobs 须为数组");
  const jobs = parsed.jobs.map(decodeJob);
  const seen = new Set<string>();
  for (const j of jobs) {
    if (seen.has(j.jobId)) throw new Error(`[processor] EnqueueRequest 含重复 jobId: ${j.jobId}`);
    seen.add(j.jobId);
  }
  return { v: 1, jobs };
}
