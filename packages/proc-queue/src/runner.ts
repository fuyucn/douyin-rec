/**
 * proc-queue/runner.ts — `ProcRunner`:租约 / 心跳 / fencing / 限额 / 磁盘准入 / 接管 recover / 关停(plans/036 §2.3)。
 *
 * 只经 core 注册表(`listProcessors`/`getProcessor`)找处理器,**不 import 任何处理器**;告警经注入的
 * `alert` 回调(proc-queue 不依赖 observability)。无注册处理器时空转(不抢租约、不建行)。
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { freeBytesOf, isSameChild, isUncertainOutcome, listProcessors, probeChild, type ChildFingerprint, type ProcActiveDTO, type ProcessContext, type Processor } from "@drec/core";

import { GC_RETAIN_MS, LEASE_MS, ProcQueueStore, procQueueDbPath, type ProcJobRecord } from "./store.js";

/**
 * 并发槽。第一期内置简单计数器({@link SimpleSlotLimiter});第二期 T2 换成 core `ResourceLimiter` 时
 * 只需实现本接口。`tryAcquire` 成功返回释放函数,满了返回 null。
 */
export interface SlotLimiter {
  tryAcquire(resource: string, lane: string): (() => void) | null;
}

/** 按 `(resource, lane)` 计数;上限由 `limitOf` 现读(节点 settings 热改生效)。 */
export class SimpleSlotLimiter implements SlotLimiter {
  private readonly used = new Map<string, number>();
  constructor(private readonly limitOf: (resource: string, lane: string) => number = () => 1) {}
  tryAcquire(resource: string, lane: string): (() => void) | null {
    const key = `${resource}/${lane}`;
    const n = this.used.get(key) ?? 0;
    if (n >= Math.max(1, Math.floor(this.limitOf(resource, lane)) || 1)) return null;
    this.used.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used.set(key, (this.used.get(key) ?? 1) - 1);
    };
  }
}

export interface ProcRunnerOpts {
  store: ProcQueueStore;
  /** 本进程唯一身份(租约 owner);serve / record 各自不同。 */
  owner: string;
  /** 现读的磁盘水位(GB;0 = 关闭)。与 daemon 同一来源由调用方注入。 */
  diskMinGB: () => number;
  /** 告警(处理器 `ctx.alert` / 磁盘不足 / recover 判 uncertain);taskId 由 `job.owner.taskId` 带出。 */
  alert: (taskId: number | undefined, msg: string) => void;
  log?: (m: string) => void;
  /** 遇他人存活持有者时是否置 `handoverRequested`(serve = true;record = false)。 */
  requestHandover?: boolean;
  limiter?: SlotLimiter;
  /** 取目录所在卷剩余字节;null = 查不到 → 放行。默认 `statfsSync` + core `freeBytesOf`。 */
  freeBytes?: (dir: string) => number | null;
  leaseMs?: number;
  heartbeatMs?: number;
  tickMs?: number;
  gcIntervalMs?: number;
  /** 非 interruptible job 关停时的最长等待(默认 15min,节点 settings `procShutdownWaitMs`)。 */
  shutdownWaitMs?: number;
  /** interruptible job abort 后的最长等待(默认 5s)。 */
  abortWaitMs?: number;
  /** false = 不起定时器(测试手动驱动 `tick()` / `heartbeat()`)。 */
  timers?: boolean;
  /** Clock for the post-yield cooldown (tests). Default monotonic `performance.now` (immune to wall-clock jumps). */
  now?: () => number;
  /** Injectable child fingerprint probe (tests). */
  probeChild?: (pid: number) => ChildFingerprint | null;
  /** How often a finished job's still-alive child is re-checked before its slot is released (default 5s). */
  childPollMs?: number;
}

const defaultFreeBytes = (dir: string): number | null => {
  try {
    let p = resolve(dir);
    while (!existsSync(p)) {
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
    return freeBytesOf(statfsSync(p));
  } catch {
    return null;
  }
};

async function withTimeout(ps: Promise<void>[], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
  const done = Promise.all(ps).then(() => true);
  try { return await Promise.race([done, timeout]); } finally { if (timer) clearTimeout(timer); }
}

interface Inflight {
  job: ProcJobRecord;
  proc: Processor;
  ac: AbortController;
  release: () => void;
  /** abort 的原因:决定收尾落点。 */
  reason: "shutdown" | "cancel" | "fenced" | null;
  settled: Promise<void>;
}

export class ProcRunner {
  private readonly o: ProcRunnerOpts;
  private readonly limiter: SlotLimiter;
  private readonly freeBytes: (dir: string) => number | null;
  private readonly leaseMs: number;
  /** 本进程当前持有租约的 kind。 */
  private readonly held = new Set<string>();
  /** 收到 handover 请求、正在让出的 kind(不再认领,跑完当前 job 就删租约)。 */
  private readonly yielding = new Set<string>();
  /**
   * kind → when we yielded it on a handover request. For one lease period we do not take it back:
   * the lease row is gone at that moment, and without this our own next tick usually beats the
   * requester (serve) to it, resetting `handoverRequested` and turning the handover into ping-pong
   * (#238). If the requester never shows up, we resume holding after the cooldown.
   */
  private readonly yieldedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly diskAlerted = new Set<string>();
  /** 正在做孤儿处置(recover + settleOrphan)的 jobId:同一行同一时刻只允许一份处置(D1)。 */
  private readonly settling = new Set<string>();
  private readonly hbFails = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  private stopping = false;

  constructor(opts: ProcRunnerOpts) {
    this.o = opts;
    this.limiter = opts.limiter ?? new SimpleSlotLimiter();
    this.freeBytes = opts.freeBytes ?? defaultFreeBytes;
    this.leaseMs = opts.leaseMs ?? LEASE_MS;
  }

  private clock(): number {
    return this.o.now ? this.o.now() : performance.now();
  }

  private log(m: string): void {
    this.o.log?.(`[proc] ${m}`);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    if (this.o.timers === false) return;
    // 先跑首个 gc / tick 再建定时器:`tick()` 不抛(内部兜住),即便首轮失败也不会留下对已关闭 store 空转的定时器。
    this.gc();
    this.tick();
    // 定时回调里的同步 DB 异常(锁超时等)不得变成 uncaughtException 拖垮 serve:吞掉但必留痕。
    const t = (fn: () => void, ms: number): void => {
      const h = setInterval(() => {
        try { fn(); } catch (e) { this.log(`定时任务异常: ${e instanceof Error ? e.message : String(e)}`); }
      }, ms);
      h.unref?.();
      this.timers.push(h);
    };
    t(() => this.heartbeat(), this.o.heartbeatMs ?? 10_000);
    t(() => this.tick(), this.o.tickMs ?? 2_000);
    t(() => this.gc(), this.o.gcIntervalMs ?? 3600_000);
  }

  // ───────────────────────── 租约 / 心跳 / fencing ─────────────────────────

  /** 心跳:续约;失败(换人)→ fencing;发现 handover → 让出;发现 cancelRequested → abort 对应 job。 */
  heartbeat(): void {
    const { store, owner } = this.o;
    for (const kind of [...this.held]) {
      let hb: { ok: boolean; handoverRequested: boolean };
      try {
        hb = store.heartbeat(kind, owner, this.leaseMs);
        this.hbFails.delete(kind);
      } catch (e) {
        // 写失败(DB 锁超时等):连续失败累计到一个租约时长 → 视为失租,fencing(别带着可能已过期的租约继续干活)。
        const n = (this.hbFails.get(kind) ?? 0) + 1;
        this.hbFails.set(kind, n);
        this.log(`${kind}: 心跳写失败(第 ${n} 次): ${e instanceof Error ? e.message : String(e)}`);
        if (n * (this.o.heartbeatMs ?? 10_000) >= this.leaseMs) this.fence(kind, "心跳连续写失败,租约视为已丢");
        continue;
      }
      if (!hb.ok) {
        this.fence(kind, "租约丢失(心跳写失败或持有者已换人)");
        continue;
      }
      if (hb.handoverRequested && !this.yielding.has(kind)) {
        this.log(`${kind}: 收到 handover 请求,跑完当前 job 后让出`);
        this.yielding.add(kind);
      }
    }
    for (const row of store.runningOf(owner)) {
      const f = this.inflight.get(row.jobId);
      if (f && row.cancelRequested && !f.reason) {
        f.reason = "cancel";
        f.ac.abort();
      }
    }
    this.finishYields();
  }

  private finishYields(): void {
    for (const kind of [...this.yielding]) {
      if ([...this.inflight.values()].some((f) => f.job.kind === kind)) continue;
      this.o.store.releaseLease(kind, this.o.owner);
      this.held.delete(kind);
      this.yielding.delete(kind);
      this.yieldedAt.set(kind, this.clock());
      this.log(`${kind}: 已让出租约`);
    }
  }

  /** 失租:abort 该 kind 全部 job(收尾不写表 —— 行已不归我们),不再认领。 */
  private fence(kind: string, why: string): void {
    this.log(`${kind}: ${why},abort 本进程该类全部 job`);
    this.held.delete(kind);
    this.yielding.delete(kind);
    this.hbFails.delete(kind);
    for (const f of this.inflight.values()) {
      if (f.job.kind !== kind) continue;
      f.reason = "fenced";
      f.ac.abort();
    }
  }

  /** 处理器在不可逆动作前调用:DB 里本进程仍是有效租约持有者才放行。 */
  private leaseOk(kind: string): boolean {
    return this.held.has(kind) && this.o.store.leaseValid(kind, this.o.owner);
  }

  // ───────────────────────── 认领循环 ─────────────────────────

  /**
   * 一轮:抢租约(+ 接管 recover)→ 按限额 / 磁盘准入认领。
   * **永不抛**:租约 / claim 的 DB 异常(锁超时等)按 kind 兜住并留痕,下一轮重试(F1:异步补跑的 tick
   * 若抛错会成为 unhandled rejection,Node 24 下直接拖垮 serve)。
   */
  tick(): void {
    if (!this.started || this.stopping) return;
    const procs = listProcessors();
    for (const p of procs) {
      if (this.held.has(p.kind) || this.yielding.has(p.kind)) continue;
      const yielded = this.yieldedAt.get(p.kind);
      if (yielded !== undefined) {
        if (this.clock() - yielded < this.leaseMs) continue;
        this.yieldedAt.delete(p.kind);
      }
      let r: { acquired: boolean; takeover: boolean };
      try {
        r = this.o.store.acquireLease(p.kind, this.o.owner, {
          leaseMs: this.leaseMs, requestHandover: this.o.requestHandover ?? false,
        });
      } catch (e) {
        this.log(`${p.kind}: 抢租约失败: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!r.acquired) continue;
      this.held.add(p.kind);
      this.log(`${p.kind}: 取得租约${r.takeover ? "(接管)" : ""}`);
      // recover 完成后立刻再跑一轮认领(rerun 的行才能马上被接走,不必等下一个 tickMs)。catch 必须在链尾。
      void this.recoverKind(p)
        .catch((e: unknown) => this.log(`${p.kind}: recover 异常 ${String(e)}`))
        .then(() => this.tick())
        .catch((e: unknown) => this.log(`${p.kind}: recover 后补跑 tick 异常 ${String(e)}`));
    }
    for (const p of procs) {
      if (!this.held.has(p.kind) || this.yielding.has(p.kind)) continue;
      try {
        this.claimLoop(p);
      } catch (e) {
        this.log(`${p.kind}: 认领失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private claimLoop(p: Processor): void {
    const lane = p.lane ?? "default";
    for (;;) {
      const release = this.limiter.tryAcquire(p.resource, lane);
      if (!release) return;
      let job: ProcJobRecord | null;
      let denied: { job: ProcJobRecord; msg: string } | null = null;
      try {
        // accept 在认领写事务内执行:只做纯判定,告警等副作用移到事务之后(不把事件发送带进写锁区间)。
        job = this.o.store.claim({
          kinds: [p.kind], owner: this.o.owner,
          accept: (j) => {
            const msg = this.diskDenied(p, j);
            if (msg !== null) denied ??= { job: j, msg };
            return msg === null;
          },
        });
      } catch (e) {
        release(); // 不泄漏并发槽
        throw e;
      }
      if (denied) this.alertDiskOnce(p, denied);
      if (!job) {
        release();
        return;
      }
      this.diskAlerted.delete(p.kind);
      this.launch(p, job, release);
    }
  }

  /** 磁盘准入(纯判定):`free − estimate ≥ diskMinGB` → null;不足 → 返回告警文案(保持 pending)。 */
  private diskDenied(p: Processor, job: ProcJobRecord): string | null {
    const minGB = this.o.diskMinGB();
    if (!(minGB > 0)) return null;
    const dir = dirname(job.outputs?.[0] ?? job.inputs[0]);
    const free = this.freeBytes(dir);
    if (free == null) return null;
    const need = p.estimateDiskBytes(job);
    if (free - need >= minGB * 1e9) return null;
    return `磁盘剩余 ${(free / 1e9).toFixed(1)}GB,预计需 ${(need / 1e9).toFixed(1)}GB,低于水位 ${minGB}GB —— ${p.kind} 任务保持排队`;
  }

  /** 按 kind 告警一次(认领成功后清标记 → 恢复后再不足可再告警)。 */
  private alertDiskOnce(p: Processor, d: { job: ProcJobRecord; msg: string }): void {
    if (this.diskAlerted.has(p.kind)) return;
    this.diskAlerted.add(p.kind);
    this.o.alert(d.job.owner.taskId, d.msg);
  }

  private ctxFor(job: ProcJobRecord, ac: AbortController): ProcessContext {
    return {
      signal: ac.signal,
      assertLease: () => {
        // 被 fence 的 job 即便同一持有者之后重获租约也不得再做不可逆动作(N2:行已按孤儿处置)。
        if (this.inflight.get(job.jobId)?.reason === "fenced" || !this.leaseOk(job.kind)) throw new Error(`[proc] 租约已丢,拒绝执行不可逆动作 (${job.jobId})`);
      },
      markProgress: () => {},
      setState: (patch) => {
        if (patch.step !== undefined) this.o.store.updateStep(job.jobId, patch.step);
        if (patch.bv !== undefined) this.o.store.setBv(job.jobId, patch.bv ?? "");
        if (patch.childPid !== undefined) this.o.store.setChildPid(job.jobId, patch.childPid, patch.childPidStartedAt ?? null);
        if (patch.progress !== undefined) this.o.store.setProgress(job.jobId, patch.progress);
      },
      log: (m) => this.log(`${job.jobId}: ${m}`),
      alert: (m) => this.o.alert(job.owner.taskId, m),
    };
  }

  private launch(proc: Processor, job: ProcJobRecord, release: () => void): void {
    const ac = new AbortController();
    const f: Inflight = { job, proc, ac, release, reason: null, settled: Promise.resolve() };
    this.inflight.set(job.jobId, f);
    f.settled = this.execute(f).catch((e: unknown) => {
      // 收尾写表失败等:行留在 running,由租约过期后的接管 recover 处置;这里必须留痕并告警。
      this.log(`${job.jobId}: 执行收尾异常: ${e instanceof Error ? e.message : String(e)}`);
      this.o.alert(job.owner.taskId, `${job.kind} 任务收尾异常,待接管处置: ${job.jobId}`);
    }).then(() => this.holdWhileChildAlive(job.jobId)).finally(() => {
      release();
      this.inflight.delete(job.jobId);
      this.finishYields();
      // N1:被 fence 的 job 收尾时不写表;若本进程此后已重新持有该类型租约(recoverKind 不会再跑),自行按孤儿处置。
      // 尚未重获租约则留给之后取得租约时的 recoverKind(此时已不在 inflight)。
      if (f.reason === "fenced" && !this.stopping && this.held.has(job.kind)) {
        void this.settleFenced(proc, job.jobId)
          .catch((e: unknown) => this.log(`${job.jobId}: fence 后孤儿处置异常 ${String(e)}`))
          .then(() => this.tick())
          .catch((e: unknown) => this.log(`${job.jobId}: fence 后补跑 tick 异常 ${String(e)}`));
      }
    });
  }

  private async settleFenced(p: Processor, jobId: string): Promise<void> {
    const row = this.o.store.runningOfKind(p.kind).find((r) => r.jobId === jobId);
    if (row) await this.settleOrphanRow(p, row, true);
  }

  /** True only when the recorded child is gone or its pid/start fingerprint no longer matches. */
  private async childStopped(job: ProcJobRecord | null): Promise<boolean> {
    if (!job || job.childPid == null) return true; // nothing spawned
    const probe = this.o.probeChild ?? probeChild;
    const current = probe(job.childPid);
    return !isSameChild({ pid: job.childPid, startedAt: job.childPidStartedAt }, current);
  }

  /**
   * The slot is bound to the child, not the row (plan 038 §4.2): a row may end uncertain while its biliup
   * child still runs, and releasing then would let a second upload start beside it. Poll until it exits.
   */
  private async holdWhileChildAlive(jobId: string): Promise<void> {
    let logged = false;
    while (!this.stopping) {
      const row = this.o.store.get(jobId);
      if (row?.childPid == null) return;
      if (!isSameChild({ pid: row.childPid, startedAt: row.childPidStartedAt }, (this.o.probeChild ?? probeChild)(row.childPid))) return;
      if (!logged) this.log(`${jobId}: child pid ${row.childPid} still running; slot held until it exits`);
      logged = true;
      await new Promise((r) => setTimeout(r, this.o.childPollMs ?? 5_000));
    }
  }

  private async execute(f: Inflight): Promise<void> {
    const { job, proc, ac } = f;
    const { store, owner } = this.o;
    const ctx = this.ctxFor(job, ac);
    try {
      const bad = proc.validate(job);
      if (bad !== null) {
        store.finish(job.jobId, owner, { state: "failed", error: `validate: ${bad}` });
        this.o.alert(job.owner.taskId, `${job.kind} 任务被拒: ${bad}`);
        return;
      }
      const res = await proc.run(job, ctx);
      if (f.reason === "fenced") return; // 已失租:行不归我们,不写表
      if (res.bv) store.setBv(job.jobId, res.bv);
      if (res.retry) {
        let ok: boolean;
        if (res.retry.reason === "slot-busy") {
          // No child was ever spawned, so there is nothing to stop and nothing to prove.
          ok = store.requeueSlotBusy(job.jobId, owner, res.retry.notBefore);
        } else {
          if (proc.interruptible) store.updateStep(job.jobId, "transfer");
          ok = store.retryTransfer(job.jobId, owner, res.retry.notBefore, await this.childStopped(store.get(job.jobId)));
        }
        if (!ok) store.finish(job.jobId, owner, { state: "failed", error: "retry requested but not allowed" });
        return;
      }
      if (!store.finish(job.jobId, owner, { state: "done", outputs: res.outputs, note: res.note })) {
        this.log(`${job.jobId}: 完成但收尾失败(持有者已换人),忽略`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (f.reason === "fenced") return;
      if (f.reason === "shutdown") {
        // 关停 abort:interruptible 回 pending(attempts 回退);非 interruptible 由 stop() 统一落 uncertain。
        if (proc.interruptible) store.releaseForShutdown(job.jobId, owner, true);
        return;
      }
      if (f.reason === "cancel") {
        store.finish(job.jobId, owner, { state: "cancelled", error: "已取消" });
        return;
      }
      if (isUncertainOutcome(e)) {
        // Outcome unknown (e.g. submit past maxWallMs): cancelled-with-intent → uncertain for biliup, never retried.
        store.finish(job.jobId, owner, { state: "cancelled", hasIntent: true, error: msg });
        this.o.alert(job.owner.taskId, `${job.kind} 任务结果无法确定,需人工确认: ${msg}`);
        return;
      }
      store.finish(job.jobId, owner, { state: "failed", error: msg });
      this.o.alert(job.owner.taskId, `${job.kind} 任务失败: ${msg}`);
    }
  }

  // ───────────────────────── 接管 recover ─────────────────────────

  /** 刚取得租约:对该 kind 非本进程在跑的 running 行逐个 `recover()`(只碰该行列出的路径)。 */
  private async recoverKind(p: Processor): Promise<void> {
    const { store, owner } = this.o;
    for (const row of store.runningOfKind(p.kind)) {
      // 本进程仍在跑的行不碰(含被 fence 但尚未退出的:N1 —— 它收尾时由 launch 的 finally 自行按孤儿处置,
      // 不在此等待,否则无视 abort 的处理器会让该行永远停在 running)。
      if (this.inflight.has(row.jobId)) continue;
      if (!(await this.settleOrphanRow(p, row, row.claimedBy === owner))) return;
    }
  }

  /** 对一行孤儿:`recover()` 判定 → settleOrphan 落点 + 告警。返回 false = recover 期间失租(调用方应停止)。 */
  private async settleOrphanRow(p: Processor, row: ProcJobRecord, allowSelf: boolean): Promise<boolean> {
    // D1:按行占位,settleFenced 与 recoverKind 不得并发处置同一行(recover 只调一次)。已占 → 跳过并继续后续行。
    if (this.settling.has(row.jobId)) return true;
    this.settling.add(row.jobId);
    try {
      // R4-1:快照可能已过期(循环开头取的行,期间别的路径已处置并回 pending / 重新认领)。占位后同步重读:
      // 不再是「同一轮的 running」就不调 recover(recover 可能删新一轮的 tmp)。占位 + 同步重读之间无其他路径可改该行。
      const cur = this.o.store.get(row.jobId);
      if (!cur || cur.state !== "running" || cur.attempts !== row.attempts) {
        this.log(`${row.jobId}: 孤儿处置跳过(行已不在原 running 轮次:state=${cur?.state ?? "缺失"} attempts=${cur?.attempts ?? "-"},快照 attempts=${row.attempts})`);
        return true;
      }
      return await this.settleOrphanRowInner(p, row, allowSelf);
    } finally {
      this.settling.delete(row.jobId);
    }
  }

  private async settleOrphanRowInner(p: Processor, row: ProcJobRecord, allowSelf: boolean): Promise<boolean> {
    const { store, owner } = this.o;
    let outcome: "rerun" | "done" | "uncertain" = "uncertain";
    let why = "该处理器未实现 recover";
    if (p.recover) {
      try {
        outcome = await p.recover(row, this.ctxFor(row, new AbortController()));
        why = "recover() 判定无法确定";
      } catch (e) {
        why = `recover 异常: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (!this.leaseOk(p.kind)) return false; // recover 期间失租,不再写
    // 以快照行 attempts 做代际 CAS:行已被重新认领(新一轮在跑)则拒写,不打回、不告警、不记 recover 落点。
    if (!store.settleOrphan(row.jobId, owner, outcome, { error: why, allowSelf, attempts: row.attempts })) {
      this.log(`${row.jobId}: 孤儿处置被拒(${this.rejectReason(row, allowSelf, p.kind)}),跳过`);
      return true;
    }
    if (outcome === "uncertain") {
      this.o.alert(row.owner.taskId, `${row.kind} 任务上次执行被中断且无法判定结果(${why}),需人工确认: ${row.jobId}`);
    }
    this.log(`${row.jobId}: 接管 recover → ${outcome}`);
    return true;
  }

  /** settleOrphan 拒写后的具体原因(排障用;只读 store,与 settleOrphan 内的判定顺序一致)。 */
  private rejectReason(row: ProcJobRecord, allowSelf: boolean, kind: string): string {
    const cur = this.o.store.get(row.jobId);
    if (!cur || cur.state !== "running") return `行状态已变为 ${cur?.state ?? "缺失"}`;
    if (cur.attempts !== row.attempts) return `行已被重新认领 attempts ${row.attempts}→${cur.attempts}`;
    if (cur.claimedBy === this.o.owner && !allowSelf) return "行属本持有者且未确认已被 fence";
    if (!this.o.store.leaseValid(kind, this.o.owner)) return "租约已失效";
    return "原因未知";
  }

  // ───────────────────────── 保留 ─────────────────────────

  private gc(): void {
    try {
      const n = this.o.store.gc({ retainMs: GC_RETAIN_MS });
      if (n > 0) this.log(`gc 清理 ${n} 行(done/cancelled > 7 天)`);
    } catch (e) {
      this.log(`gc 失败: ${String(e)}`);
    }
  }

  // ───────────────────────── 关停 ─────────────────────────

  /**
   * 关停(serve shutdown 首步):停止认领 → interruptible 的 running 立即 abort 回 pending(attempts 不变)→
   * 非 interruptible 等待至完成(上限 `shutdownWaitMs`),到点 abort 并记 `uncertain` → 删自己的租约行。
   * 不删 inputs(那是处理器的不可逆动作,须 `assertLease`;租约先于 job 收尾之后才删,且 abort 后处理器应删 tmp)。
   */
  async stop(): Promise<void> {
    if (this.stopping && !this.started) return;
    this.stopping = true;
    this.started = false;
    for (const h of this.timers) clearInterval(h);
    this.timers = [];
    const { store, owner } = this.o;
    const all = [...this.inflight.values()];
    for (const f of all) {
      if (!f.proc.interruptible || f.reason) continue;
      f.reason = "shutdown";
      f.ac.abort();
    }
    const abortWait = this.o.abortWaitMs ?? 5_000;
    const waitMs = this.o.shutdownWaitMs ?? 15 * 60_000;
    const interruptible = all.filter((f) => f.proc.interruptible);
    if (!(await withTimeout(interruptible.map((f) => f.settled), abortWait))) {
      // 处理器无视 abort:强制回 pending(租约随后删除,其后续 assertLease 必失败)。
      for (const f of interruptible) {
        if (this.inflight.has(f.job.jobId)) store.releaseForShutdown(f.job.jobId, owner, true, { kind: f.job.kind, step: f.job.step });
      }
    }
    const rest = all.filter((f) => !f.proc.interruptible);
    if (!(await withTimeout(rest.map((f) => f.settled), waitMs))) {
      for (const f of rest) {
        if (!this.inflight.has(f.job.jobId)) continue;
        f.reason = "shutdown";
        f.ac.abort();
        const current = store.get(f.job.jobId);
        const stopped = await this.childStopped(current);
        const verified = stopped && f.proc.verifyStopped
          ? await f.proc.verifyStopped(current ?? f.job, this.ctxFor(f.job, f.ac)).catch(() => "uncertain")
          : "uncertain";
        if (verified === "safe") {
          // biliup has no intent before submit; a verified stop may safely return to pending.
          if (f.proc.interruptible || (f.job.kind === "biliup" && (current?.step === "gate_wait" || current?.step === "transfer" || current?.step == null))) {
            store.releaseForShutdown(f.job.jobId, owner, true, { kind: f.job.kind, step: current?.step ?? f.job.step });
          } else {
            store.finish(f.job.jobId, owner, { state: "cancelled", hasIntent: true, error: "关停等待超时,执行被中止,结果无法确定" });
          }
        } else {
          // 取消落点走契约 `cancelOutcome`(不自造):已进入不可打断动作 → hasIntent=true(biliup → uncertain,其余 → cancelled)。
          store.finish(f.job.jobId, owner, { state: "cancelled", hasIntent: true, error: "关停等待超时,执行被中止,结果无法确定" });
        }
        this.o.alert(f.job.owner.taskId, `${f.job.kind} 任务关停超时,结果无法确定,需人工确认: ${f.job.jobId}`);
      }
    }
    for (const kind of [...this.held]) store.releaseLease(kind, owner);
    this.held.clear();
    this.yielding.clear();
    this.yieldedAt.clear();
  }

  // ───────────────────────── 快照 ─────────────────────────

  /** `GET /api/proc/active` 的 body。running/pending 含已注册 kind(无行为 0)。 */
  active(): ProcActiveDTO {
    const { running, pending } = this.o.store.active();
    const dto: ProcActiveDTO = { host: this.started && !this.stopping, running: { ...running }, pending: { ...pending }, leaseAlive: {} };
    const kinds = new Set([...listProcessors().map((p) => p.kind), ...Object.keys(running), ...Object.keys(pending)]);
    for (const k of kinds) {
      dto.running[k] ??= 0;
      dto.pending[k] ??= 0;
      dto.leaseAlive[k] = this.o.store.leaseAlive(k);
    }
    return dto;
  }
}

/**
 * 只读快照(`_node-status` 用):库不存在 / 未迁移 → 全空(不创建文件、不跑迁移);存在则只读连接查询。
 * `host` 恒 false(调用方是独立 CLI 进程,不是 runner 宿主)。
 */
export function readProcActive(dataRoot: string): ProcActiveDTO {
  const path = procQueueDbPath(dataRoot);
  const empty: ProcActiveDTO = { host: false, running: {}, pending: {}, leaseAlive: {} };
  if (!existsSync(path)) return empty;
  let store: ProcQueueStore;
  try {
    store = new ProcQueueStore(path, { readOnly: true }); // 只读连接:不切 WAL、不迁移、不跑写事务
  } catch {
    return empty;
  }
  try {
    const { running, pending } = store.active();
    const kinds = new Set([...Object.keys(running), ...Object.keys(pending), ...store.leaseKinds()]);
    const dto: ProcActiveDTO = { host: false, running, pending, leaseAlive: {} };
    for (const k of kinds) {
      dto.running[k] ??= 0;
      dto.pending[k] ??= 0;
      dto.leaseAlive[k] = store.leaseAlive(k);
    }
    return dto;
  } catch {
    return empty; // 库存在但尚未迁移(表缺失)等:视为空快照
  } finally {
    store.close();
  }
}
