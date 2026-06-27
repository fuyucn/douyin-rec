import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { PipelineDeps } from "./pipeline.js";
import { runPipeline } from "./pipeline.js";
import { clusterBroadcasts } from "./identity.js";

export interface ReconcilerDeps {
  platform: string;
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  pipelineDeps: PipelineDeps;
  /** Injectable for testing; defaults to the real runPipeline. */
  runPipeline?: typeof runPipeline;
}

const RETRYABLE = new Set<JobState>(["pending", "failed"]);

export class Reconciler {
  private platform: string;
  private transports: Map<string, Transport>;
  private ledger: SyncLedger;
  private pipelineDeps: PipelineDeps;
  private _runPipeline: typeof runPipeline;

  constructor(deps: ReconcilerDeps) {
    this.platform = deps.platform;
    this.transports = deps.transports;
    this.ledger = deps.ledger;
    this.pipelineDeps = deps.pipelineDeps;
    this._runPipeline = deps.runPipeline ?? runPipeline;
  }

  async reconcileAll(): Promise<void> {
    // 1. Concurrently fetch all inventories; dead tenants degrade to empty, don't abort.
    const invs = await Promise.all(
      [...this.transports.values()].map((t) =>
        t.listInventory().catch(() => ({ tenantId: t.id, recordings: [] })),
      ),
    );

    // 2. Cluster recordings across nodes into broadcasts.
    const broadcasts = clusterBroadcasts(
      this.platform,
      invs.map((i) => ({ tenantId: i.tenantId, recordings: i.recordings })),
    );

    // 3. For each broadcast: idempotent upsert + run pipeline if needed.
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
