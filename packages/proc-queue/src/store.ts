/**
 * proc-queue/store.ts — 每节点持久任务表 `ProcQueueStore`(plans/036 §2.3)。
 *
 * `<root>/db/proc-queue.db`(`node:sqlite`,WAL + busy_timeout)。**任何进程首开都执行幂等迁移**
 * (`PRAGMA user_version` + `CREATE TABLE IF NOT EXISTS`,包在 `BEGIN IMMEDIATE` 内)。
 * 多进程同时首开:首次切 WAL 需排他锁,busy_timeout 对它不生效(直接报 `database is locked`),
 * 故 `PRAGMA journal_mode=WAL` 单独带退避重试(`initWal`);test/proc-queue/store-multiproc.test.ts 用真进程钉住。
 * 全部写操作是同步的、单条 `BEGIN IMMEDIATE` 事务 → 跨进程(serve / record)互斥靠 sqlite 文件锁。
 *
 * 只经 core 的状态机(`canTransition` / `cancelOutcome`)判迁移合法性,不自造第二套;不 import 任何处理器、
 * 不扫目录(只 `stat` 回填文件标识)。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertJobInvariants, canTransition, cancelOutcome, jobIdOf,
  type EnqueueResult, type JobState, type ProcessJob, type UploadProgress,
} from "@drec/core";
import { migrateSchema } from "./schema.js";
import { ProcLeaseStore } from "./lease.js";

const WAL_RETRIES = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `<dataRoot>/db/proc-queue.db`。路径单点(app/orchestrator/cli 都经它,不各拼一份)。 */
export function procQueueDbPath(dataRoot: string): string {
  return join(dataRoot, "db", "proc-queue.db");
}

/** logicalKey 以此结尾 = 派发方不知道文件标识,由执行节点 enqueue 时对 `inputs[0]` stat 回填 `${ino}-${size}`。 */
export const FILE_TAG_PLACEHOLDER = "@";

/**
 * `${ino}-${size}`。用 bigint stat:64 位 inode(xfs/btrfs 大盘)可能超 2^53,Number 会丢精度(N8)。
 * 文件不存在 / 不可读 → 抛错。
 */
export function fileTagOf(path: string, stat: typeof statSync = statSync): string {
  const st = stat(path, { bigint: true });
  return `${String(st.ino)}-${String(st.size)}`;
}

export { LEASE_MS } from "./lease-types.js";
import { LEASE_MS } from "./lease-types.js";
import type { LeaseRow } from "./lease-types.js";
export const GC_RETAIN_MS = 7 * 24 * 3600_000;

/** 任务行(契约字段 + 执行态)。 */
export interface ProcJobRecord extends ProcessJob {
  state: JobState;
  attempts: number;
  claimedBy: string | null;
  /** 曾经被认领过(只增不减;`cancelIfUnclaimed` 的判据 —— attempts 会因关停回退而不可靠)。 */
  everClaimed: boolean;
  cancelRequested: boolean;
  /** done 时的实际产物。 */
  resultOutputs: string[] | null;
  note: string | null;
  error: string | null;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  notBefore: number | null;
  orderKey: string | null;
  seq: number | null;
  step: string | null;
  bv: string | null;
  seasonState: "pending" | "done" | "failed" | null;
  childPid: number | null;
  childPidStartedAt: string | null;
  prepJobId: string | null;
  /** Latest byte progress reported by the processor (display only). */
  progress: UploadProgress | null;
}

export type { LeaseRow } from "./lease-types.js";

/** A batch was rejected and rolled back; `results` lists earlier entries plus the failure. */
export class BatchRejected extends Error {
  constructor(message: string, readonly results: EnqueueResult[]) { super(message); this.name = "BatchRejected"; }
}

export type FinishOutcome =
  | { state: "done"; outputs: string[]; note?: string }
  | { state: "failed"; error: string }
  | { state: "uncertain"; error: string }
  /** 取消落点经 `cancelOutcome(kind, hasIntent)`;第一期无 intent 概念,hasIntent 缺省 false。 */
  | { state: "cancelled"; hasIntent?: boolean; error?: string };

export interface ProcQueueStoreOpts {
  now?: () => number;
  /** pid 是否存活(测试可注入);默认 `process.kill(pid, 0)`。仅用于提前接管,过期才是权威。 */
  isPidAlive?: (pid: number) => boolean;
  log?: (m: string) => void;
  /** sqlite busy_timeout(默认 5000ms;测试可调小以快速观察锁冲突)。 */
  busyTimeoutMs?: number;
  /** 只读打开:不建目录、不切 WAL、不迁移、只读连接;库/表缺失时查询抛错由调用方兜。 */
  readOnly?: boolean;
}

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权限 = 活着
  }
};

type Row = Record<string, unknown>;

function toRecord(r: Row): ProcJobRecord {
  const outputs = r.outputs == null ? undefined : (JSON.parse(String(r.outputs)) as string[]);
  const rec: ProcJobRecord = {
    jobId: String(r.jobId),
    kind: String(r.kind),
    logicalKey: String(r.logicalKey),
    generation: Number(r.generation),
    inputs: JSON.parse(String(r.inputs)) as string[],
    params: JSON.parse(String(r.params)) as Record<string, unknown>,
    replaceInputs: Number(r.replaceInputs) === 1,
    owner: {
      ...(r.ownerTaskId != null ? { taskId: Number(r.ownerTaskId) } : {}),
      ...(r.ownerStreamKey != null ? { streamKey: String(r.ownerStreamKey) } : {}),
    },
    createdAt: Number(r.createdAt),
    state: String(r.state) as JobState,
    attempts: Number(r.attempts),
    claimedBy: r.claimedBy == null ? null : String(r.claimedBy),
    everClaimed: Number(r.everClaimed) === 1,
    cancelRequested: Number(r.cancelRequested) === 1,
    resultOutputs: r.resultOutputs == null ? null : (JSON.parse(String(r.resultOutputs)) as string[]),
    note: r.note == null ? null : String(r.note),
    error: r.error == null ? null : String(r.error),
    updatedAt: Number(r.updatedAt),
    startedAt: r.startedAt == null ? null : Number(r.startedAt),
    finishedAt: r.finishedAt == null ? null : Number(r.finishedAt),
    notBefore: r.notBefore == null ? null : Number(r.notBefore),
    orderKey: r.orderKey == null ? null : String(r.orderKey),
    seq: r.seq == null ? null : Number(r.seq),
    step: r.step == null ? null : String(r.step),
    bv: r.bv == null ? null : String(r.bv),
    seasonState: r.seasonState === "pending" || r.seasonState === "done" || r.seasonState === "failed"
      ? r.seasonState
      : null,
    childPid: r.childPid == null ? null : Number(r.childPid),
    childPidStartedAt: r.childPidStartedAt == null ? null : String(r.childPidStartedAt),
    prepJobId: r.prepJobId == null ? null : String(r.prepJobId),
    progress: parseProgress(r.progress),
  };
  if (outputs) rec.outputs = outputs;
  return rec;
}

/** Display-only JSON: anything malformed reads as "no progress", never as an error. */
function parseProgress(raw: unknown): UploadProgress | null {
  if (raw == null) return null;
  try {
    const p = JSON.parse(String(raw)) as Partial<UploadProgress>;
    const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
    if (!num(p.doneBytes) || !num(p.totalBytes) || !num(p.at)) return null;
    return { doneBytes: p.doneBytes, totalBytes: p.totalBytes, bps: num(p.bps) ? p.bps : null, at: p.at };
  } catch { return null; }
}

function toLease(r: Row): LeaseRow {
  return {
    kind: String(r.kind), owner: String(r.owner), pid: Number(r.pid),
    heartbeatAt: Number(r.heartbeatAt), expiresAt: Number(r.expiresAt),
    handoverRequested: Number(r.handoverRequested) === 1,
  };
}

export interface ListFilter {
  kind?: string;
  state?: JobState;
  ownerTaskId?: number;
  limit?: number;
}

export class ProcQueueStore {
  private readonly db: DatabaseSync;
  private readonly leases!: ProcLeaseStore;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(readonly dbPath: string, opts: ProcQueueStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultPidAlive;
    if (opts.readOnly) {
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000}`);
      this.leases = new ProcLeaseStore(this.db, { now: this.now, isPidAlive: this.isPidAlive });
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000}`);
    this.initWal();
    this.migrate();
    this.leases = new ProcLeaseStore(this.db, { now: this.now, isPidAlive: this.isPidAlive });
  }

  /**
   * 切 WAL(幂等)。已是 WAL 直接返回;否则退避重试 `locked/busy`:并发首开时 busy_timeout 对
   * journal_mode 切换不生效,不重试会让后到的进程直接抛 `database is locked`(F3 实测 2 进程 43% 失败)。
   */
  private initWal(): void {
    for (let i = 0; ; i++) {
      try {
        const cur = (this.db.prepare("PRAGMA journal_mode").get() as Row).journal_mode;
        if (String(cur).toLowerCase() === "wal") return;
        this.db.exec("PRAGMA journal_mode=WAL");
        return;
      } catch (e) {
        if (i >= WAL_RETRIES || !/locked|busy/i.test((e as Error).message)) throw e;
        sleepSync(5 + Math.random() * 25);
      }
    }
  }

  /** Idempotent migration (see schema.ts); runs on every open and upgrades old databases step by step. */
  private migrate(): void {
    migrateSchema(this.db);
  }

  /** `BEGIN IMMEDIATE` 事务;抛错回滚并重抛。 */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      throw e;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  // ───────────────────────── 读 ─────────────────────────

  get(jobId: string): ProcJobRecord | null {
    const r = this.db.prepare("SELECT * FROM proc_jobs WHERE jobId=?").get(jobId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  list(f: ListFilter = {}): ProcJobRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.kind !== undefined) { where.push("kind=?"); args.push(f.kind); }
    if (f.state !== undefined) { where.push("state=?"); args.push(f.state); }
    if (f.ownerTaskId !== undefined) { where.push("ownerTaskId=?"); args.push(f.ownerTaskId); }
    const sql = `SELECT * FROM proc_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt, rowid LIMIT ?`;
    args.push(f.limit ?? 1000);
    return (this.db.prepare(sql).all(...args) as Row[]).map(toRecord);
  }

  /** 各 kind 的 running / pending 计数(只含有行的 kind)。 */
  active(): { running: Record<string, number>; pending: Record<string, number> } {
    const out = { running: {} as Record<string, number>, pending: {} as Record<string, number> };
    const rows = this.db
      .prepare("SELECT kind, state, COUNT(*) AS n FROM proc_jobs WHERE state IN ('running','pending') GROUP BY kind, state")
      .all() as Row[];
    for (const r of rows) out[String(r.state) as "running" | "pending"][String(r.kind)] = Number(r.n);
    return out;
  }

  /** 下一代 generation(同 kind+logicalKey 已有最大代 +1;无则 1)。 */
  nextGeneration(kind: string, logicalKey: string): number {
    const r = this.db
      .prepare("SELECT MAX(generation) AS g FROM proc_jobs WHERE kind=? AND logicalKey=?")
      .get(kind, logicalKey) as Row;
    return (r.g == null ? 0 : Number(r.g)) + 1;
  }

  // ───────────────────────── 入队 ─────────────────────────

  /**
   * 幂等入队。`allowedRoots` 必传(fail-closed):违反契约 → `rejected`(不抛)。
   * 顺序:契约校验 → stat `inputs[0]`(失败 → `rejected`)→ 回填 fileTag(logicalKey 以 `@` 结尾时)→
   * 同 jobId 已存在:done 且产物缺失 → `stale`(附 `nextGeneration`);否则原样回报现态,**不改任何行**。
   * 返回的 `jobId` 是回填后的最终 id。
   */
  enqueue(job: ProcessJob, opts: { allowedRoots: readonly string[] }): EnqueueResult {
    try {
      assertJobInvariants(job, { allowedRoots: opts.allowedRoots });
    } catch (e) {
      return { jobId: job.jobId, state: "rejected", error: (e as Error).message };
    }
    let tag: string;
    try {
      tag = fileTagOf(job.inputs[0]);
    } catch (e) {
      return { jobId: job.jobId, state: "rejected", error: `inputs[0] cannot be stat-ed: ${(e as Error).message}` };
    }
    const logicalKey = job.logicalKey.endsWith(FILE_TAG_PLACEHOLDER) ? `${job.logicalKey}${tag}` : job.logicalKey;
    return this.tx(() => this.enqueueTx(job, logicalKey));
  }

  private enqueueTx(job: ProcessJob, logicalKey: string): EnqueueResult {
    const jobId = jobIdOf(job.kind, logicalKey, job.generation);
    const existing = this.get(jobId);
    if (existing) {
      switch (existing.state) {
        case "pending": return { jobId, state: "pending" };
        case "running": return { jobId, state: "running" };
        case "done": {
          const targets = existing.resultOutputs ?? existing.outputs ?? [];
          if (targets.some((p) => !existsSync(p))) {
            return { jobId, state: "stale", nextGeneration: this.nextGeneration(job.kind, logicalKey) };
          }
          return { jobId, state: "done" };
        }
        default:
          // failed / uncertain / cancelled: never revive implicitly (requeue / ackUncertain only).
          return {
            jobId, state: "rejected", error: `已存在且 state=${existing.state}(需人工处理)`,
            existingState: existing.state as "failed" | "uncertain" | "cancelled",
          };
      }
    }
    const t = this.now();
    this.db.prepare(
      `INSERT INTO proc_jobs(jobId, kind, logicalKey, generation, state, inputs, outputs, params, replaceInputs,
         ownerTaskId, ownerStreamKey, createdAt, updatedAt, orderKey, seq, notBefore, prepJobId)
       VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId, job.kind, logicalKey, job.generation, JSON.stringify(job.inputs),
      job.outputs ? JSON.stringify(job.outputs) : null, JSON.stringify(job.params), job.replaceInputs ? 1 : 0,
      job.owner.taskId ?? null, job.owner.streamKey ?? null, t, t,
      job.orderKey ?? null, job.seq ?? null, job.notBefore ?? null, job.prepJobId ?? null,
    );
    return { jobId, state: "pending" };
  }

  /** Next generation for one orderKey (shared by the whole session, not per logicalKey). */
  nextOrderGeneration(orderKey: string): number {
    const r = this.db
      .prepare("SELECT MAX(generation) AS g FROM proc_jobs WHERE orderKey=?")
      .get(orderKey) as Row;
    return (r.g == null ? 0 : Number(r.g)) + 1;
  }

  /**
   * Atomic batch enqueue: either every job lands as pending, or none does.
   * Any `rejected` or `stale` throws `BatchRejected` and rolls back the whole transaction,
   * so an ordered session never gets a gap in its seq sequence.
   */
  enqueueBatch(jobs: readonly ProcessJob[], opts: { allowedRoots: readonly string[] }): EnqueueResult[] {
    return this.tx(() => {
      const out: EnqueueResult[] = [];
      for (const job of jobs) {
        let logicalKey: string;
        try {
          assertJobInvariants(job, { allowedRoots: opts.allowedRoots });
          let tag: string;
          try { tag = fileTagOf(job.inputs[0]); }
          catch (e) { throw new Error(`inputs[0] cannot be stat-ed: ${(e as Error).message}`); }
          logicalKey = job.logicalKey.endsWith(FILE_TAG_PLACEHOLDER) ? `${job.logicalKey}${tag}` : job.logicalKey;
        } catch (e) {
          const error = (e as Error).message;
          const failed = { jobId: job.jobId, state: "rejected" as const, error };
          const err = new BatchRejected(`batch enqueue rejected (${job.jobId}): ${error}`, [...out, failed]);
          throw err;
        }
        const r = this.enqueueTx(job, logicalKey);
        if (r.state === "stale") {
          throw new BatchRejected(`batch enqueue hit stale (${r.jobId}): re-dispatch with a new generation`, [...out, r]);
        }
        if (r.state === "rejected") {
          throw new BatchRejected(`batch enqueue rejected (${job.jobId}): ${r.error ?? "unknown"}`, [...out, r]);
        }
        out.push(r);
      }
      return out;
    });
  }

  /**
   * Persist byte progress of a running job (display only). Does not bump updatedAt: progress is
   * written every few seconds and must not look like a state change to anything sorting by it.
   */
  setProgress(jobId: string, progress: UploadProgress | null): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET progress=? WHERE jobId=? AND state='running'")
      .run(progress ? JSON.stringify(progress) : null, jobId).changes > 0);
  }

  /** Advance the observable step; does not change the state machine. */
  updateStep(jobId: string, step: string | null): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET step=?, updatedAt=? WHERE jobId=? AND state='running'")
      .run(step, this.now(), jobId).changes > 0);
  }

  setBv(jobId: string, bv: string): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET bv=?, updatedAt=? WHERE jobId=?")
      .run(bv, this.now(), jobId).changes > 0);
  }

  /** Persist a newly created BV together with its season intent in one row update. */
  setBvAndSeasonState(jobId: string, bv: string, state: "pending" | "done" | "failed" | null): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET bv=?, seasonState=?, updatedAt=? WHERE jobId=?")
      .run(bv, state, this.now(), jobId).changes > 0);
  }

  /** Persist the best-effort Bilibili season association checkpoint. */
  setSeasonState(jobId: string, state: "pending" | "done" | "failed" | null): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET seasonState=?, updatedAt=? WHERE jobId=?")
      .run(state, this.now(), jobId).changes > 0);
  }

  setChildPid(jobId: string, pid: number | null, startedAt: string | null = null): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET childPid=?, childPidStartedAt=?, updatedAt=? WHERE jobId=?")
      .run(pid, startedAt, this.now(), jobId).changes > 0);
  }

  /**
   * Transfer retry: running -> pending with a backoff, without consuming an extra attempt
   * (claim already incremented it). Only for biliup in gate_wait/transfer with a stopped child.
   */
  retryTransfer(jobId: string, owner: string, notBefore: number, childConfirmedStopped: boolean): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      if (!canTransition("running", "pending", {
        reason: "transfer-retry", kind: row.kind, step: row.step, childConfirmedStopped,
      })) return false;
      this.db.prepare(
        "UPDATE proc_jobs SET state='pending', claimedBy=NULL, notBefore=?, updatedAt=? WHERE jobId=? AND state='running'",
      ).run(notBefore, this.now(), jobId);
      return true;
    });
  }

  /**
   * Busy node-wide upload slot: running -> pending with backoff, no child-stopped proof needed because no
   * upload was started (plan 038 PR4).
   */
  requeueSlotBusy(jobId: string, owner: string, notBefore: number): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      if (!canTransition("running", "pending", { reason: "slot-busy", kind: row.kind })) return false;
      this.db.prepare(
        "UPDATE proc_jobs SET state='pending', claimedBy=NULL, notBefore=?, updatedAt=?, progress=NULL WHERE jobId=? AND state='running'",
      ).run(notBefore, this.now(), jobId);
      return true;
    });
  }

  /** Cancel later pending rows of one order/generation; returns how many rows changed. */
  cascadeOrderBlocked(orderKey: string, generation: number, afterSeq: number, reason = "order-blocked"): number {
    return this.tx(() => this.db.prepare(
      `UPDATE proc_jobs SET state='cancelled', error=?, finishedAt=?, updatedAt=?
       WHERE orderKey=? AND generation=? AND seq>? AND state='pending'`,
    ).run(`cancelled (${reason})`, this.now(), this.now(), orderKey, generation, afterSeq).changes as number);
  }

  /** Cancel every pending biliup row of one order/generation after its prep failed. */
  cascadePrepFailed(orderKey: string, generation: number): number {
    return this.tx(() => this.db.prepare(
      `UPDATE proc_jobs SET state='cancelled', error=?, finishedAt=?, updatedAt=?
       WHERE orderKey=? AND generation=? AND state='pending' AND kind='biliup'`,
    ).run("cancelled (order-prep-failed)", this.now(), this.now(), orderKey, generation).changes as number);
  }

  clearChildPid(jobId: string): boolean {
    return this.tx(() => this.db.prepare("UPDATE proc_jobs SET childPid=NULL, childPidStartedAt=NULL, updatedAt=? WHERE jobId=?")
      .run(this.now(), jobId).changes > 0);
  }

  // ───────────────────────── Lease (implemented in lease.ts) ─────────────────────────

  getLease(kind: string): LeaseRow | null { return this.leases.getLease(kind); }
  leaseKinds(): string[] { return this.leases.leaseKinds(); }
  leaseAlive(kind: string): boolean { return this.leases.leaseAlive(kind); }
  leaseValid(kind: string, owner: string): boolean { return this.leases.leaseValid(kind, owner); }
  acquireLease(kind: string, owner: string, o: Parameters<ProcLeaseStore["acquireLease"]>[2] = {}) {
    return this.leases.acquireLease(kind, owner, o);
  }
  heartbeat(kind: string, owner: string, leaseMs?: number) { return this.leases.heartbeat(kind, owner, leaseMs); }
  releaseLease(kind: string, owner: string): boolean { return this.leases.releaseLease(kind, owner); }
  yieldLease(kind: string, owner: string, reserveMs?: number): boolean { return this.leases.yieldLease(kind, owner, reserveMs); }
  reservedUntil(kind: string): number { return this.leases.reservedUntil(kind); }

  // ───────────────────────── 认领 / 执行态 ─────────────────────────

  /**
   * 认领最老的 pending 行(`BEGIN IMMEDIATE`,两连接并发只一个成功)。
   * 只认领 `kinds` 内、且 `owner` 持有**有效租约**的 kind(DB 级 fencing)。
   * `cancelRequested` 的待执行行(曾认领、关停回退后才被取消)**不执行**,认领时直接落终态(经
   * `cancelOutcome`,等价 pending→running→cancelled 一步完成,`attempts` 不增),避免永远停在 pending。
   * `accept` 在事务内逐候选同步判定(须纯判定,不得做告警等副作用):返回 false 则跳过该候选,不改行。
   */
  claim(o: { kinds: readonly string[]; owner: string; accept?: (job: ProcJobRecord) => boolean }): ProcJobRecord | null {
    if (o.kinds.length === 0) return null;
    return this.tx(() => {
      const t = this.now();
      const marks = o.kinds.map(() => "?").join(",");
      const cands = this.db.prepare(
        `SELECT j.* FROM proc_jobs j JOIN proc_runner_lease l ON l.kind=j.kind AND l.owner=? AND l.expiresAt>?
         WHERE j.state='pending' AND j.kind IN (${marks})
           AND (j.notBefore IS NULL OR j.notBefore<=?)
           AND (j.orderKey IS NULL OR NOT EXISTS (
             SELECT 1 FROM proc_jobs p
             WHERE p.orderKey=j.orderKey AND p.generation=j.generation
               AND p.seq<j.seq AND p.state<>'done'))
           AND (j.prepJobId IS NULL OR EXISTS (
             SELECT 1 FROM proc_jobs q WHERE q.jobId=j.prepJobId AND q.state='done'))
         ORDER BY COALESCE((SELECT c.lastClaimedAt FROM proc_order_cursor c
                            WHERE c.orderKey=j.orderKey AND c.generation=j.generation), 0),
                  j.createdAt, j.rowid`,
      ).all(o.owner, t, ...o.kinds, t) as Row[];
      for (const c of cands) {
        const rec = toRecord(c);
        if (rec.cancelRequested) {
          const to = cancelOutcome(rec.kind, false);
          this.db.prepare(
            `UPDATE proc_jobs SET state=?, error='已取消(认领前已请求取消)', finishedAt=?, updatedAt=?
             WHERE jobId=? AND state='pending'`,
          ).run(to, t, t, rec.jobId);
          continue;
        }
        if (o.accept && !o.accept(rec)) continue;
        this.db.prepare(
          `UPDATE proc_jobs SET state='running', claimedBy=?, attempts=attempts+1, everClaimed=1,
             startedAt=?, updatedAt=?, error=NULL, progress=NULL WHERE jobId=? AND state='pending'`,
        ).run(o.owner, t, t, rec.jobId);
        if (rec.orderKey) {
          this.db.prepare(
            `INSERT INTO proc_order_cursor(orderKey, generation, lastClaimedAt) VALUES(?,?,?)
             ON CONFLICT(orderKey, generation) DO UPDATE SET lastClaimedAt=excluded.lastClaimedAt`,
          ).run(rec.orderKey, rec.generation, t);
        }
        return this.get(rec.jobId);
      }
      return null;
    });
  }

  /** running 行的当前状态读取(runner 心跳时查 `cancelRequested`)。 */
  runningOf(owner: string): ProcJobRecord[] {
    return (this.db.prepare("SELECT * FROM proc_jobs WHERE state='running' AND claimedBy=?").all(owner) as Row[]).map(toRecord);
  }

  /** 某 kind 的全部 running 行(接管时 recover 用)。 */
  runningOfKind(kind: string): ProcJobRecord[] {
    return (this.db.prepare("SELECT * FROM proc_jobs WHERE state='running' AND kind=?").all(kind) as Row[]).map(toRecord);
  }

  /**
   * 收尾:校验行为 running 且 `claimedBy===owner`、迁移合法;否则返回 false(调用方已失去该 job,不得再动其产物)。
   */
  finish(jobId: string, owner: string, outcome: FinishOutcome): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      return this.applyFinish(row, outcome);
    });
  }

  private applyFinish(row: ProcJobRecord, outcome: FinishOutcome): boolean {
    const t = this.now();
    let to: JobState = outcome.state;
    if (outcome.state === "cancelled") to = cancelOutcome(row.kind, outcome.hasIntent ?? false);
    if (!canTransition("running", to)) return false;
    const error = "error" in outcome ? (outcome.error ?? null) : null;
    this.db.prepare(
      `UPDATE proc_jobs SET state=?, resultOutputs=?, note=?, error=?, updatedAt=?, finishedAt=?
       WHERE jobId=? AND state='running'`,
    ).run(
      to, outcome.state === "done" ? JSON.stringify(outcome.outputs) : null,
      outcome.state === "done" ? (outcome.note ?? null) : null, error, t, t, row.jobId,
    );
    return true;
  }

  /**
   * running → pending(关停 abort):只允许 `interruptible` 的 job;`attempts` 回退(关停不算一次尝试)。
   * 校验持有者。返回是否成功。
   */
  releaseForShutdown(jobId: string, owner: string, interruptible: boolean, ctx: { kind?: string; step?: string | null } = {}): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      const shutdownAllowed = interruptible
        || (ctx.kind === "biliup" && (ctx.step === "gate_wait" || ctx.step === "transfer"));
      if (!canTransition("running", "pending", { reason: "shutdown-abort", interruptible: shutdownAllowed })) return false;
      this.db.prepare(
        `UPDATE proc_jobs SET state='pending', claimedBy=NULL, attempts=MAX(attempts-1,0), updatedAt=? WHERE jobId=?`,
      ).run(this.now(), jobId);
      return true;
    });
  }

  /**
   * 接管后处置前任遗留的 running 行(`recover()` 的结果落库)。调用方须已持有该 kind 的有效租约。
   * rerun → pending(`attempts` 保持:那次尝试已发生);done → done;uncertain → uncertain(不自动重跑)。
   * `info.attempts` 给出时为代际 CAS:与当前行不一致则不写、返回 false。
   */
  settleOrphan(
    jobId: string, newOwner: string, outcome: "rerun" | "done" | "uncertain",
    info: { error?: string; allowSelf?: boolean; attempts?: number } = {},
  ): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running") return false;
      // 代际 CAS(D1):传入快照行的 attempts,已被重新认领(attempts 变了)的新一轮不得被旧快照的处置打回/收尾。
      if (info.attempts !== undefined && row.attempts !== info.attempts) return false;
      // 本持有者名下的行默认拒绝(可能正在跑);仅 runner 确认「已被 fence、不在执行」时 allowSelf(F2)。
      if (row.claimedBy === newOwner && !info.allowSelf) return false;
      if (!this.leaseValid(row.kind, newOwner)) return false;
      if (outcome === "rerun") {
        if (!canTransition("running", "pending", { reason: "lease-expired-rerun" })) return false;
        this.db.prepare("UPDATE proc_jobs SET state='pending', claimedBy=NULL, updatedAt=? WHERE jobId=?").run(this.now(), jobId);
        return true;
      }
      return this.applyFinish(
        row,
        outcome === "done"
          ? { state: "done", outputs: row.outputs ?? [], note: "接管后判定已完成" }
          : { state: "uncertain", error: info.error ?? "接管后无法判定上次执行结果" },
      );
    });
  }

  // ───────────────────────── 人工 / 取消 ─────────────────────────

  /** failed → pending(唯一入口)。`retryable=false`(如 biliup)拒绝。返回是否成功。 */
  requeue(jobId: string, o: { retryable?: boolean } = {}): boolean {
    if (o.retryable === false) return false;
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || !canTransition(row.state, "pending", { reason: "requeue" })) return false;
      this.db.prepare(
        `UPDATE proc_jobs SET state='pending', claimedBy=NULL, error=NULL, finishedAt=NULL, updatedAt=? WHERE jobId=?`,
      ).run(this.now(), jobId);
      return true;
    });
  }

  /** uncertain → failed(人工确认「已知结果不确定」后才能 requeue / purge)。 */
  ackUncertain(jobId: string): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || !canTransition(row.state, "failed", { reason: "ack-uncertain" })) return false;
      this.db.prepare("UPDATE proc_jobs SET state='failed', updatedAt=? WHERE jobId=?").run(this.now(), jobId);
      return true;
    });
  }

  /** pending → cancelled,**仅当从未被认领**(原子条件更新)。已认领 → false。 */
  cancelIfUnclaimed(jobId: string): boolean {
    const t = this.now();
    const res = this.db.prepare(
      `UPDATE proc_jobs SET state='cancelled', finishedAt=?, updatedAt=?
       WHERE jobId=? AND state='pending' AND everClaimed=0`,
    ).run(t, t, jobId);
    return Number(res.changes) > 0;
  }

  /**
   * 取消:从未认领的 pending 直接 cancelled;running 置 `cancelRequested`(执行者心跳时发现并 abort);
   * pending 但已认领过(关停回退)也置标记,下次 `claim` 扫到时直接落终态(不执行)。其余状态 noop。
   */
  requestCancel(jobId: string): "cancelled" | "requested" | "noop" {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row) return "noop";
      if (row.state === "pending" && !row.everClaimed) {
        return this.cancelIfUnclaimed(jobId) ? "cancelled" : "noop";
      }
      if (row.state === "pending" || row.state === "running") {
        this.db.prepare("UPDATE proc_jobs SET cancelRequested=1, updatedAt=? WHERE jobId=?").run(this.now(), jobId);
        return "requested";
      }
      return "noop";
    });
  }

  // ───────────────────────── 保留 ─────────────────────────

  /**
   * 清理:done/cancelled 超过 `retainMs`(默认 7 天)删;**failed / uncertain 不自动删**。
   * `purgeFailed` 时额外删 failed(人工清,`_proc-gc --purge-failed` / `POST /api/proc/purge`);
   * uncertain 须先 `ackUncertain` 转 failed 才会被删。返回删除行数。
   */
  gc(o: { retainMs?: number; purgeFailed?: boolean } = {}): number {
    const cutoff = this.now() - (o.retainMs ?? GC_RETAIN_MS);
    let n = Number(
      this.db.prepare("DELETE FROM proc_jobs WHERE state IN ('done','cancelled') AND finishedAt IS NOT NULL AND finishedAt<?")
        .run(cutoff).changes,
    );
    if (o.purgeFailed) n += Number(this.db.prepare("DELETE FROM proc_jobs WHERE state='failed'").run().changes);
    return n;
  }
}
