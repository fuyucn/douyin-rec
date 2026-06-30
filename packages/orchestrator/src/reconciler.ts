import type { Transport, NodeInventory } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { PipelineDeps, PipelineCfg } from "./pipeline.js";
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
  /**
   * 按平台 + 房间解析该场的 pipeline 配置(来自 hub 任务文件 config/hub/{platform}.{roomSlug}.json)。
   * 返回 null → 该房间没开 hub(无配置文件 / 已禁用)→ **跳过不处理**。
   * 不提供 → 用全局 pipelineDeps.cfg(兼容旧的全局模式 / 测试)。
   * 带 platform 入参 → 多平台天然就绪(douyin/bilibili 同房间号不撞)。
   */
  resolveCfg?: (platform: string, roomSlug: string) => PipelineCfg | null;
  /** pipeline 失败的最大自动重试次数;达到后留 failed 不再重入。默认 3。 */
  maxRetries?: number;
}

const DEFAULT_SETTLE: SettleConfig = { maxWaitMs: 600_000, pollMs: 15_000 };
const DEFAULT_INVENTORY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
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
  private maxRetries: number;
  private resolveCfg?: (platform: string, roomSlug: string) => PipelineCfg | null;

  constructor(deps: ReconcilerDeps) {
    this.platform = deps.platform;
    this.transports = deps.transports;
    this.ledger = deps.ledger;
    this.pipelineDeps = deps.pipelineDeps;
    this._runPipeline = deps.runPipeline ?? runPipeline;
    this.settle = deps.settle ?? DEFAULT_SETTLE;
    this.sleep = deps.sleep ?? DEFAULT_SLEEP;
    this.inventoryTimeoutMs = deps.inventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.resolveCfg = deps.resolveCfg;
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
   * 轮询各成员 isDone(roomSlug) 直到全部收播或 maxWaitMs 超时。无 isDone 的 transport 视为已收播。
   * isDone 抛错按"未收播"算(但不中止循环)。
   * **返回仍未收播的成员 key 集合(`tenantId:roomSlug`)** —— 调用方据此跳过仍在录制的场,
   * 避免边录边合并残片(Bug B:之前超时即"继续对账"处理残片 → job 标终态 → 真收播被跳过)。
   */
  private async settleAll(broadcasts: ReturnType<typeof clusterBroadcasts>): Promise<Set<string>> {
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

    if (pending.size === 0) return pending;

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
        `[reconciler] settle 超时 — 以下节点仍在录制，本轮跳过其所在场，待录完后续轮再处理: ${timedOut.join(", ")}`,
      );
    }
    return pending;
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

    // 3. Settle: 等各成员收播;返回仍在录的成员 key 集。
    const stillRecording = await this.settleAll(broadcasts);

    // 4. For each broadcast: idempotent upsert + run pipeline if needed.
    for (const b of broadcasts) {
      try {
        // 仍有成员在录制 → 本轮跳过(不建 job、不合并残片),待其录完的后续轮再处理。
        if (b.members.some((m) => stillRecording.has(`${m.tenantId}:${m.rec.roomSlug}`))) continue;

        // 按任务取该房间的 pipeline 配置;resolveCfg 返回 null = 该房间没开 hub → 跳过。
        // 不提供 resolveCfg → 用全局 pipelineDeps.cfg(兼容旧的全局模式)。
        let cfg = this.pipelineDeps.cfg;
        if (this.resolveCfg) {
          const resolved = this.resolveCfg(this.platform, b.roomSlug);
          if (!resolved) continue; // 房间未开 hub 任务 → 不处理
          cfg = resolved;
        }

        const job = this.ledger.get(b.streamKey);

        // Skip terminal states.
        if (job?.state === "done" || job?.state === "needs_manual") continue;

        // failed 且已达重试上限 → 放弃自动重试(留 failed 供人工/诊断),不再重入。
        if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) continue;

        const { isNew } = this.ledger.upsertPending(b.streamKey);

        // Don't re-enter an in-progress job unless it was retryable.
        if (!isNew && job && !RETRYABLE.has(job.state)) continue;

        await this._runPipeline(b, { ...this.pipelineDeps, cfg });
      } catch (err) {
        // Per-broadcast 出错:置 job=failed(可见 + 重试上限内自动重试),不中止其余 broadcast。
        console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
        this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
      }
    }
  }
}
