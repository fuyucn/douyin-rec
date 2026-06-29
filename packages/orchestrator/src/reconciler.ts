import type { Transport, NodeInventory } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { PipelineDeps } from "./pipeline.js";
import { runPipeline } from "./pipeline.js";
import { clusterBroadcasts } from "./identity.js";

export interface SettleConfig {
  maxWaitMs: number;
  pollMs: number;
}

export interface ReconcilerDeps {
  platform: string;
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  pipelineDeps: PipelineDeps;
  /** Injectable for testing; defaults to the real runPipeline. */
  runPipeline?: typeof runPipeline;
  /** Settle config: poll isDone on all transports before running the pipeline. */
  settle?: SettleConfig;
  /** Injectable sleep for testing; defaults to real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** 单个租户 listInventory 的超时(ms);挂起即降级为空,防一个 hung 节点锁死整轮对账。默认 60s。 */
  inventoryTimeoutMs?: number;
}

const DEFAULT_SETTLE: SettleConfig = { maxWaitMs: 600_000, pollMs: 15_000 };
const DEFAULT_INVENTORY_TIMEOUT_MS = 60_000;
const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = new Set<JobState>(["pending", "failed"]);

export class Reconciler {
  private platform: string;
  private transports: Map<string, Transport>;
  private ledger: SyncLedger;
  private pipelineDeps: PipelineDeps;
  private _runPipeline: typeof runPipeline;
  private settle: SettleConfig;
  private sleep: (ms: number) => Promise<void>;
  private inventoryTimeoutMs: number;

  constructor(deps: ReconcilerDeps) {
    this.platform = deps.platform;
    this.transports = deps.transports;
    this.ledger = deps.ledger;
    this.pipelineDeps = deps.pipelineDeps;
    this._runPipeline = deps.runPipeline ?? runPipeline;
    this.settle = deps.settle ?? DEFAULT_SETTLE;
    this.sleep = deps.sleep ?? DEFAULT_SLEEP;
    this.inventoryTimeoutMs = deps.inventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS;
  }

  /** listInventory 包超时:挂起超过 inventoryTimeoutMs 即降级为空(该租户本轮缺席),不锁死整轮。 */
  private async inventoryWithTimeout(t: Transport): Promise<NodeInventory> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<NodeInventory>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[reconciler] 租户 ${t.id} listInventory 超时 ${this.inventoryTimeoutMs}ms,本轮按空处理`);
        resolve({ tenantId: t.id, recordings: [] });
      }, this.inventoryTimeoutMs);
    });
    try {
      return await Promise.race([
        t.listInventory().catch(() => ({ tenantId: t.id, recordings: [] })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Poll all transports' isDone(roomSlug) for each broadcast member until ALL return true,
   * or maxWaitMs elapses. Transports without isDone are treated as done.
   * isDone() errors count as "not done" for that round but never abort the loop.
   * After settling, always proceed (runs pipeline even if some nodes timed out).
   */
  private async settleAll(broadcasts: ReturnType<typeof clusterBroadcasts>): Promise<void> {
    const { maxWaitMs, pollMs } = this.settle;
    const deadline = Date.now() + maxWaitMs;

    // Collect unique (tenantId, roomSlug) pairs across all broadcasts
    const pending = new Set<string>();
    const memberMap = new Map<string, { tenantId: string; roomSlug: string }>();
    for (const b of broadcasts) {
      for (const m of b.members) {
        const key = `${m.tenantId}:${m.rec.roomSlug}`;
        pending.add(key);
        memberMap.set(key, { tenantId: m.tenantId, roomSlug: m.rec.roomSlug });
      }
    }

    if (pending.size === 0) return;

    while (pending.size > 0 && Date.now() < deadline) {
      // Check all pending members this round
      const toRemove: string[] = [];
      for (const key of pending) {
        const { tenantId, roomSlug } = memberMap.get(key)!;
        const transport = this.transports.get(tenantId);
        if (!transport || typeof transport.isDone !== "function") {
          // Transport doesn't support isDone → treat as done
          toRemove.push(key);
          continue;
        }
        try {
          const done = await transport.isDone(roomSlug);
          if (done) toRemove.push(key);
        } catch {
          // Error counts as "not done" this round; loop continues
        }
      }
      for (const key of toRemove) pending.delete(key);

      if (pending.size === 0) break;
      if (Date.now() < deadline) await this.sleep(pollMs);
    }

    // Log any members that timed out
    if (pending.size > 0) {
      const timedOut = [...pending].map((k) => {
        const { tenantId, roomSlug } = memberMap.get(k)!;
        return `${tenantId}/${roomSlug}`;
      });
      console.warn(
        `[reconciler] settle timeout — 以下节点仍在录制，将继续对账: ${timedOut.join(", ")}`,
      );
    }
  }

  async reconcileAll(): Promise<void> {
    // 1. Concurrently fetch all inventories; 挂起的租户经 inventoryWithTimeout 降级为空(不锁死整轮),
    //    出错的租户也降级为空,均不中止其余节点。
    const invs = await Promise.all(
      [...this.transports.values()].map((t) => this.inventoryWithTimeout(t)),
    );

    // 2. Cluster recordings across nodes into broadcasts.
    const broadcasts = clusterBroadcasts(
      this.platform,
      invs.map((i) => ({ tenantId: i.tenantId, recordings: i.recordings })),
    );

    // 3. Settle: wait for all members to finish recording before running pipeline.
    await this.settleAll(broadcasts);

    // 4. For each broadcast: idempotent upsert + run pipeline if needed.
    for (const b of broadcasts) {
      try {
        const job = this.ledger.get(b.streamKey);

        // Skip terminal states.
        if (job?.state === "done" || job?.state === "needs_manual") continue;

        const { isNew } = this.ledger.upsertPending(b.streamKey);

        // Don't re-enter an in-progress job unless it was retryable.
        if (!isNew && job && !RETRYABLE.has(job.state)) continue;

        await this._runPipeline(b, this.pipelineDeps);
      } catch (err) {
        // Per-broadcast errors are logged and swallowed so remaining broadcasts proceed.
        console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
      }
    }
  }
}
