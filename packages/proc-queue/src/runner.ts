/**
 * proc-queue/runner.ts — `ProcRunner`:租约 / 心跳 / fencing / 限额 / 磁盘准入 / 接管 recover / 关停(plans/036 §2.3)。
 *
 * 只经 core 注册表(`listProcessors`/`getProcessor`)找处理器,**不 import 任何处理器**;告警经注入的
 * `alert` 回调(proc-queue 不依赖 observability)。无注册处理器时空转(不抢租约、不建行)。
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { freeBytesOf, listProcessors, type ProcActiveDTO, type ProcessContext, type Processor } from "@drec/core";
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
  private readonly inflight = new Map<string, Inflight>();
  private readonly diskAlerted = new Set<string>();
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

  private log(m: string): void {
    this.o.log?.(`[proc] ${m}`);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    if (this.o.timers === false) return;
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
    this.gc();
    this.tick();
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
      this.log(`${kind}: 已让出租约`);
    }
  }

  /** 失租:abort 该 kind 全部 job(收尾不写表 —— 行已不归我们),不再认领。 */
  private fence(kind: string, why: string): void {
    this.log(`${kind}: ${why},abort 本进程该类全部 job`);
    this.held.delete(kind);
    this.yielding.delete(kind);
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

  /** 一轮:抢租约(+ 接管 recover)→ 按限额 / 磁盘准入认领。 */
  tick(): void {
    if (!this.started || this.stopping) return;
    const procs = listProcessors();
    for (const p of procs) {
      if (this.held.has(p.kind) || this.yielding.has(p.kind)) continue;
      const r = this.o.store.acquireLease(p.kind, this.o.owner, {
        leaseMs: this.leaseMs, requestHandover: this.o.requestHandover ?? false,
      });
      if (!r.acquired) continue;
      this.held.add(p.kind);
      this.log(`${p.kind}: 取得租约${r.takeover ? "(接管)" : ""}`);
      // recover 完成后立刻再跑一轮认领(rerun 的行才能马上被接走,不必等下一个 tickMs)。
      void this.recoverKind(p)
        .catch((e: unknown) => this.log(`${p.kind}: recover 异常 ${String(e)}`))
        .then(() => this.tick());
    }
    for (const p of procs) {
      if (!this.held.has(p.kind) || this.yielding.has(p.kind)) continue;
      this.claimLoop(p);
    }
  }

  private claimLoop(p: Processor): void {
    const lane = p.lane ?? "default";
    for (;;) {
      const release = this.limiter.tryAcquire(p.resource, lane);
      if (!release) return;
      let job: ProcJobRecord | null;
      try {
        job = this.o.store.claim({ kinds: [p.kind], owner: this.o.owner, accept: (j) => this.diskAdmit(p, j) });
      } catch (e) {
        release(); // 不泄漏并发槽
        throw e;
      }
      if (!job) {
        release();
        return;
      }
      this.diskAlerted.delete(p.kind);
      this.launch(p, job, release);
    }
  }

  /** 磁盘准入:`free − estimate ≥ diskMinGB`;不足 → 保持 pending,按 kind 告警一次(恢复后清标记)。 */
  private diskAdmit(p: Processor, job: ProcJobRecord): boolean {
    const minGB = this.o.diskMinGB();
    if (!(minGB > 0)) return true;
    const dir = dirname(job.outputs?.[0] ?? job.inputs[0]);
    const free = this.freeBytes(dir);
    if (free == null) return true;
    const need = p.estimateDiskBytes(job);
    if (free - need >= minGB * 1e9) return true;
    if (!this.diskAlerted.has(p.kind)) {
      this.diskAlerted.add(p.kind);
      this.o.alert(job.owner.taskId, `磁盘剩余 ${(free / 1e9).toFixed(1)}GB,预计需 ${(need / 1e9).toFixed(1)}GB,低于水位 ${minGB}GB —— ${p.kind} 任务保持排队`);
    }
    return false;
  }

  private ctxFor(job: ProcJobRecord, ac: AbortController): ProcessContext {
    return {
      signal: ac.signal,
      assertLease: () => {
        if (!this.leaseOk(job.kind)) throw new Error(`[proc] 租约已丢,拒绝执行不可逆动作 (${job.jobId})`);
      },
      markProgress: () => {},
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
    }).finally(() => {
      release();
      this.inflight.delete(job.jobId);
      this.finishYields();
    });
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
      store.finish(job.jobId, owner, { state: "failed", error: msg });
      this.o.alert(job.owner.taskId, `${job.kind} 任务失败: ${msg}`);
    }
  }

  // ───────────────────────── 接管 recover ─────────────────────────

  /** 刚取得租约:对该 kind 非本进程在跑的 running 行逐个 `recover()`(只碰该行列出的路径)。 */
  private async recoverKind(p: Processor): Promise<void> {
    const { store, owner } = this.o;
    for (const row of store.runningOfKind(p.kind)) {
      if (this.inflight.has(row.jobId)) continue;
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
      if (!this.leaseOk(p.kind)) return; // recover 期间失租,不再写
      store.settleOrphan(row.jobId, owner, outcome, { error: why });
      if (outcome === "uncertain") {
        this.o.alert(row.owner.taskId, `${row.kind} 任务上次执行被中断且无法判定结果(${why}),需人工确认: ${row.jobId}`);
      }
      this.log(`${row.jobId}: 接管 recover → ${outcome}`);
    }
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
    const withTimeout = async (ps: Promise<void>[], ms: number): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
      const done = Promise.all(ps).then(() => true);
      try { return await Promise.race([done, timeout]); } finally { if (timer) clearTimeout(timer); }
    };
    const interruptible = all.filter((f) => f.proc.interruptible);
    if (!(await withTimeout(interruptible.map((f) => f.settled), abortWait))) {
      // 处理器无视 abort:强制回 pending(租约随后删除,其后续 assertLease 必失败)。
      for (const f of interruptible) {
        if (this.inflight.has(f.job.jobId)) store.releaseForShutdown(f.job.jobId, owner, true);
      }
    }
    const rest = all.filter((f) => !f.proc.interruptible);
    if (!(await withTimeout(rest.map((f) => f.settled), waitMs))) {
      for (const f of rest) {
        if (!this.inflight.has(f.job.jobId)) continue;
        f.reason = "shutdown";
        f.ac.abort();
        store.finish(f.job.jobId, owner, { state: "uncertain", error: "关停等待超时,执行结果无法确定" });
        this.o.alert(f.job.owner.taskId, `${f.job.kind} 任务关停超时,结果无法确定,需人工确认: ${f.job.jobId}`);
      }
    }
    for (const kind of [...this.held]) store.releaseLease(kind, owner);
    this.held.clear();
    this.yielding.clear();
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
 * 只读快照(`_node-status` 用):库不存在 → 全空(不创建文件、不跑迁移);存在则开只读语义的 store 查询。
 * `host` 恒 false(调用方是独立 CLI 进程,不是 runner 宿主)。
 */
export function readProcActive(dataRoot: string): ProcActiveDTO {
  const path = procQueueDbPath(dataRoot);
  const empty: ProcActiveDTO = { host: false, running: {}, pending: {}, leaseAlive: {} };
  if (!existsSync(path)) return empty;
  const store = new ProcQueueStore(path);
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
  } finally {
    store.close();
  }
}
