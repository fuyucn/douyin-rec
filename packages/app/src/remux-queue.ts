/**
 * app/remux-queue.ts — 录制进程里的「封口转换 → 任务表」接缝(plans/036 T6)。
 *
 * `record` 进程(serve 拉起的子进程与独立 record 同一规则)经它:把封口分段入队为 `remux` 任务,并按 §2.3 租约规则
 * 宿主一个 `ProcRunner`:**只在无存活持有者时持有 remux 租约**(serve 先持有则只入队);持有期间 serve 置
 * `handoverRequested` → 跑完当前 job 后让出。收尾 {@link RemuxQueue.waitSettled} 保留总时限等待。
 *
 * 打不开任务表(库损坏 / 锁死 / 磁盘只读)→ {@link RemuxQueue.open} 返回 null 并告警,调用方回落
 * 现有进程内串行链(稳定版兜底)。
 */
import { basename, resolve } from "node:path";
import { jobIdOf, parseJobId, type EnqueueResult, type ProcessJob, type StageFormat } from "@drec/core";
import { ProcQueueStore, ProcRunner } from "@drec/proc-queue";
import { remuxTargetPath } from "@drec/processors";
import { currentDiskMinGB } from "./disk-gate.js";
import { procQueueDbPath } from "./paths.js";

export type RemuxWaitOutcome = "settled" | "handed-over" | "timeout";

/** 钩子工厂依赖的最小面(便于测试注入假队列)。 */
export interface RemuxQueueLike {
  /** 入队一个封口分段;返回回执(`rejected` = 契约/路径不合法或 stat 失败,调用方回落进程内转换)。store 异常会抛。 */
  enqueue(src: string, fmt: StageFormat): EnqueueResult;
  /** 收尾等待本进程入队的行落定:`settled` / `handed-over`(持有者已是别的进程,不再占预算)/ `timeout`。 */
  waitSettled(budgetMs: number): Promise<RemuxWaitOutcome>;
}

export interface RemuxQueueOpts {
  /** 临时文件归属 + logicalKey 里的任务标识(无 taskId 时用)。 */
  owner: string;
  taskId?: number;
  /** 录制输出目录:入队的路径白名单(`assertJobInvariants` 的 allowedRoots)。 */
  outDir: string;
  /** 告警(→ 通知 error 事件通道,与 `@@DREC_ALERT@@` 同源)。 */
  alert: (message: string) => void;
  log?: (message: string) => void;
  dbPath?: string;
  diskMinGB?: () => number;
  /** 测试接缝。 */
  pollMs?: number;
  timers?: boolean;
  heartbeatMs?: number;
  tickMs?: number;
  leaseMs?: number;
  pid?: number;
}

const TERMINAL = new Set(["done", "failed", "uncertain", "cancelled"]);

export class RemuxQueue implements RemuxQueueLike {
  private readonly mine = new Set<string>();
  private readonly allowedRoots: string[];
  private closed = false;

  private constructor(
    private readonly store: ProcQueueStore,
    private readonly runner: ProcRunner,
    private readonly runnerOwner: string,
    private readonly o: RemuxQueueOpts,
  ) {
    this.allowedRoots = [resolve(o.outDir)];
  }

  /** 打开任务表并起 runner;失败 → null(已 log + 告警「回落进程内串行转换」)。 */
  static open(o: RemuxQueueOpts): RemuxQueue | null {
    let store: ProcQueueStore | undefined;
    try {
      store = new ProcQueueStore(o.dbPath ?? procQueueDbPath(), { log: o.log });
      const runnerOwner = `record:${o.pid ?? process.pid}:${Date.now()}`;
      const runner = new ProcRunner({
        store, owner: runnerOwner, requestHandover: false,
        diskMinGB: o.diskMinGB ?? ((): number => currentDiskMinGB(o.log)),
        alert: (_taskId, message) => o.alert(message),
        log: o.log,
        timers: o.timers, heartbeatMs: o.heartbeatMs, tickMs: o.tickMs, leaseMs: o.leaseMs,
      });
      runner.start();
      return new RemuxQueue(store, runner, runnerOwner, o);
    } catch (e) {
      try { store?.close(); } catch { /* 已不可用 */ }
      const msg = `处理任务表不可用,封口转换回落为进程内串行转换: ${(e as Error)?.message ?? e}`;
      o.log?.(`[remux] ${msg}`);
      o.alert(msg);
      return null;
    }
  }

  enqueue(src: string, fmt: StageFormat): EnqueueResult {
    const abs = resolve(src);
    const prefix = this.o.taskId !== undefined ? `task${this.o.taskId}` : `room${this.o.owner}`;
    const logicalKey = `${prefix}:${basename(abs)}@`; // `@` 占位:store 回填 `${ino}-${size}`
    const mk = (generation: number, key: string): ProcessJob => ({
      jobId: jobIdOf("remux", key, generation), kind: "remux", logicalKey: key, generation,
      inputs: [abs], outputs: [remuxTargetPath(abs, fmt)], params: { format: fmt, owner: this.o.owner }, replaceInputs: true,
      owner: this.o.taskId !== undefined ? { taskId: this.o.taskId } : {}, createdAt: Date.now(),
    });
    let r = this.store.enqueue(mk(1, logicalKey), { allowedRoots: this.allowedRoots });
    if (r.state === "stale" && r.nextGeneration) {
      // 同 jobId 已 done 但目标已不在:以节点算出的下一代重派一次。
      const parsed = parseJobId(r.jobId);
      if (parsed) r = this.store.enqueue(mk(r.nextGeneration, parsed.logicalKey), { allowedRoots: this.allowedRoots });
    }
    if (r.state !== "rejected") this.mine.add(r.jobId);
    try { this.runner.tick(); } catch { /* tick 自身不抛;防御 */ } // 无存活持有者时立即接管,不等下一个 tickMs
    return r;
  }

  /** 本进程是否持有 remux 租约(DB 权威判据)。 */
  isHost(): boolean {
    return this.store.leaseValid("remux", this.runnerOwner);
  }

  async waitSettled(budgetMs: number): Promise<RemuxWaitOutcome> {
    const deadline = Date.now() + budgetMs;
    const pollMs = this.o.pollMs ?? 250;
    for (;;) {
      const pending = [...this.mine].filter((id) => {
        const row = this.store.get(id);
        return row !== null && !TERMINAL.has(row.state);
      });
      if (pending.length === 0) return "settled";
      // 有他人(serve)持有存活租约 → 它常驻、会做完,不占用本进程剩余预算、不告超时。
      if (!this.isHost()) {
        if (this.store.leaseAlive("remux")) return "handed-over";
        this.runner.tick(); // 无人持有:先接管再等
      }
      if (Date.now() >= deadline) return "timeout";
      await new Promise<void>((r) => setTimeout(r, pollMs));
    }
  }

  /** 进程退出前:abort 在跑的 job(回 pending)、删自己的租约行、关库。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.runner.stop(); } catch (e) { this.o.log?.(`[remux] runner 停止异常: ${(e as Error)?.message ?? e}`); }
    try { this.store.close(); } catch { /* 已关 */ }
  }

  /** `process.on("exit")` 用的同步兜底:只删自己的租约行(其余 job 由租约过期后的接管 recover 处置)。 */
  releaseLeaseSync(): void {
    if (this.closed) return;
    try { this.store.releaseLease("remux", this.runnerOwner); } catch { /* 尽力而为 */ }
  }
}
