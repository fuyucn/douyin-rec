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
  /** pipeline 失败的最大自动重试次数;达到后升级 needs_manual 不再重入。默认 3。 */
  maxRetries?: number;
  /** retrying job / running 节点超过该时长视为进程重启中断,标 failed 后可重入。默认 600s。 */
  staleMs?: number;
  /**
   * 断流重连合并窗(ms):结束时间距现在不足该窗的场先不处理(等可能的重连并成一簇);
   * 同时作为同房间聚类容差(窗口内开播的新会话并入同一场)。默认 10 分钟。
   */
  reconnectWindowMs?: number;
  /** 达重试上限升级 needs_manual 时发一次通知(webhook/UI)。省略 → 只转状态不通知。 */
  notify?: (e: import("@drec/core").NotifyEvent) => void;
  /**
   * 实时重载(Approach A):每轮 reconcileAll 开头调用重建 transports Map。
   * 无状态 transport 重建极廉价。省略 → 用构造时的 transports(旧行为/测试)。
   */
  loadTransports?: () => Map<string, Transport>;
}

const DEFAULT_SETTLE: SettleConfig = { maxWaitMs: 600_000, pollMs: 15_000 };
const DEFAULT_INVENTORY_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_STALE_MS = 600_000;
const DEFAULT_RECONNECT_WINDOW_MS = 10 * 60_000;
const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = new Set<JobState>(["pending", "failed"]);
const UNSAFE_RETRY_NODES = new Set(["upload_plain", "append_danmu", "append_livechat"]);

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
  private staleMs: number;
  private reconnectWindowMs: number;
  private notify?: (e: import("@drec/core").NotifyEvent) => void;
  private resolveCfg?: (platform: string, roomSlug: string) => PipelineCfg | null;
  private loadTransports?: () => Map<string, Transport>;

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
    this.staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
    this.reconnectWindowMs = deps.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    this.notify = deps.notify;
    this.resolveCfg = deps.resolveCfg;
    this.loadTransports = deps.loadTransports;
  }

  /** listInventory 包超时:挂起超过 inventoryTimeoutMs 即降级为空(该 worker 本轮缺席),不锁死整轮。 */
  private async inventoryWithTimeout(t: Transport): Promise<NodeInventory> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<NodeInventory>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[reconciler] worker ${t.id} listInventory 超时 ${this.inventoryTimeoutMs}ms,本轮按空处理`);
        resolve({ workerId: t.id, recordings: [] });
      }, this.inventoryTimeoutMs);
    });
    try {
      return await Promise.race([
        t.listInventory().catch(() => ({ workerId: t.id, recordings: [] })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轮询各成员 isDone(roomSlug) 直到全部收播或 maxWaitMs 超时。无 isDone 的 transport 视为已收播。
   * isDone 抛错按"未收播"算(但不中止循环)。
   * **返回仍未收播的成员 key 集合(`workerId:roomSlug`)** —— 调用方据此跳过仍在录制的场,
   * 避免边录边合并残片(Bug B:之前超时即"继续对账"处理残片 → job 标终态 → 真收播被跳过)。
   */
  private async settleAll(broadcasts: ReturnType<typeof clusterBroadcasts>): Promise<Set<string>> {
    const { maxWaitMs, pollMs } = this.settle;
    const deadline = Date.now() + maxWaitMs;

    // Collect unique (workerId, roomSlug) pairs across all broadcasts
    const pending = new Set<string>();
    const memberMap = new Map<string, { workerId: string; roomSlug: string }>();
    for (const b of broadcasts) {
      for (const m of b.members) {
        const key = `${m.workerId}:${m.rec.roomSlug}`;
        pending.add(key);
        memberMap.set(key, { workerId: m.workerId, roomSlug: m.rec.roomSlug });
      }
    }

    while (pending.size > 0 && Date.now() < deadline) {
      // Check all pending members this round
      const toRemove: string[] = [];
      for (const key of pending) {
        const { workerId, roomSlug } = memberMap.get(key)!;
        const transport = this.transports.get(workerId);
        if (typeof transport?.isDone !== "function") {
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
        const { workerId, roomSlug } = memberMap.get(k)!;
        return `${workerId}/${roomSlug}`;
      });
      console.warn(
        `[reconciler] settle 超时 — 以下节点仍在录制，本轮跳过其所在场，待录完后续轮再处理: ${timedOut.join(", ")}`,
      );
    }
    return pending;
  }

  /**
   * 第二份清单里新出现的成员(第一份快照后才开录/才被扫到)没进过 settleAll 的等待集。
   * 逐个现查一次 isDone;未收播 → 并入 stillRecording,调用方跳过该场。
   * 无 isDone 的 transport 视为已收播(与 settleAll 一致);isDone 抛错按未收播算。
   */
  private async settleLateMembers(
    first: ReturnType<typeof clusterBroadcasts>,
    current: ReturnType<typeof clusterBroadcasts>,
    stillRecording: Set<string>,
  ): Promise<void> {
    const firstKeys = new Set<string>();
    for (const b of first) {
      for (const m of b.members) firstKeys.add(`${m.workerId}:${m.rec.roomSlug}`);
    }
    for (const b of current) {
      for (const m of b.members) {
        const key = `${m.workerId}:${m.rec.roomSlug}`;
        if (firstKeys.has(key) || stillRecording.has(key)) continue;
        const transport = this.transports.get(m.workerId);
        if (typeof transport?.isDone !== "function") continue;
        try {
          if (!(await transport.isDone(m.rec.roomSlug))) {
            console.warn(
              `[reconciler] 清单刷新后新出现的成员 ${m.workerId}/${m.rec.roomSlug} 仍在录,本轮跳过其所在场`,
            );
            stillRecording.add(key);
          }
        } catch {
          console.warn(`[reconciler] 成员 ${m.workerId}/${m.rec.roomSlug} isDone 查询失败,按未收播处理,本轮跳过其所在场`);
          stillRecording.add(key);
        }
      }
    }
  }

  /**
   * 收一份权威清单并聚类:
   * 1. Concurrently fetch all inventories; 挂起的租户经 inventoryWithTimeout 降级为空(不锁死整轮),
   *    出错的租户也降级为空,均不中止其余节点。
   * 2. Cluster recordings across nodes into broadcasts —— 按每条录像的 platform 聚类(多平台)。
   *    this.platform 仅作旧录像(meta 无 platform)的兜底默认。
   * 2.5 按每场规则解析 cfg + **worker 硬过滤**(单一插入点:聚类后、settle 前)。
   *   - resolveCfg 返回 null(房间没开 hub)→ 清空 members → settle 不等它、循环跳过。
   *   - cfg.workers 显式非空 → 只留 workerId∈workers 的成员;缺省/空 = 全部(向后兼容)。
   */
  private async collect(
    transports: Map<string, Transport>,
    knownKeys: Iterable<{ streamKey: string; startMs?: number | null; updatedAt?: number }> = [],
  ): Promise<{
    broadcasts: ReturnType<typeof clusterBroadcasts>;
    cfgByKey: Map<string, PipelineCfg>;
  }> {
    const invs = await Promise.all(
      [...transports.values()].map((t) => this.inventoryWithTimeout(t)),
    );

    const broadcasts = clusterBroadcasts(
      invs.map((i) => ({ workerId: i.workerId, recordings: i.recordings })),
      this.reconnectWindowMs,
      this.platform,
      knownKeys,
    );

    const cfgByKey = new Map<string, PipelineCfg>();
    for (const b of broadcasts) {
      let cfg = this.pipelineDeps.cfg;
      if (this.resolveCfg) {
        const resolved = this.resolveCfg(b.platform, b.roomSlug); // 按本场 platform 取配置(多平台)
        if (!resolved) { b.members = []; continue; }              // 房间未开 hub → 本场不处理
        cfg = resolved;
      }
      if (cfg.workers?.length) {
        b.members = b.members.filter((m) => cfg.workers!.includes(m.workerId));
      }
      cfgByKey.set(b.streamKey, cfg);   // 过滤后仍有/无成员都缓存;空成员在循环里跳过
    }
    return { broadcasts, cfgByKey };
  }

  async reconcileAll(): Promise<void> {
    // 实时重载:重建 transports(反映 hub.config.json 最新 workers);同步给 pipeline 用的那份。
    if (this.loadTransports) this.transports = this.loadTransports();
    const transports = this.transports;
    // 崩溃恢复:retrying job / running 节点超过 staleMs → 标 failed(「进程重启中断」),下一段逻辑决定重跑/人工。
    // 本进程正在跑的场(长 merge/burn/上传超过 staleMs 属正常)不误杀;重启后无活动才清理。
    this.ledger.sweepStale(this.staleMs, (streamKey) => this.pipelineDeps.pool?.hasStreamLock(streamKey) ?? false);

    // 第一份清单只用来确定「要等哪些场收播」;settle 期间节点可能还在写新分段,
    // 旧快照会漏尾巴 → settle 后必须再收一份权威清单,选优/合并只用新快照。
    const first = await this.collect(transports);

    // 3. Settle: 只等(过滤后)仍有成员的场收播;返回仍在录的成员 key 集。
    const stillRecording = await this.settleAll(first.broadcasts);

    // 已知 job key 传给聚类:同一天已有 base key 的 job(哪怕已 done)→ 本簇强制 _HHMM,
    // 否则第二场直播会复用 base key 被幂等跳过。
    const { broadcasts, cfgByKey } = await this.collect(transports, this.ledger.listKeys());

    // 3.5 第一份快照之后才出现的成员没经过 settle 等待(典型:首快照为空 → settle 秒回 →
    // 第二份快照才发现刚开播的分段)。现查 isDone,未收播则本轮跳过,防边录边合并残片。
    await this.settleLateMembers(first.broadcasts, broadcasts, stillRecording);

    // 4. For each broadcast: idempotent upsert + run pipeline if needed.
    for (const b of broadcasts) {
      try {
        // 过滤后无成员 → 房间没开 hub / 选中 worker 没人录到 → 跳过(不建 job)。
        if (b.members.length === 0) continue;
        // 仍有成员在录制 → 本轮跳过(不建 job、不合并残片),待其录完的后续轮再处理。
        if (b.members.some((m) => stillRecording.has(`${m.workerId}:${m.rec.roomSlug}`))) continue;

        const cfg = cfgByKey.get(b.streamKey) ?? this.pipelineDeps.cfg;
        // 断流重连窗口:最后一段结束还没超过 reconnectWindowMs,先不处理(可能马上重连并成同一场)。
        const latestEndMs = Math.max(...b.members.map((m) => m.rec.endMs));
        const windowMs = cfg.reconnectWindowMs ?? this.reconnectWindowMs;
        if (windowMs > 0 && Date.now() - latestEndMs < windowMs) {
          console.info(`[reconciler] ${b.streamKey} 结束 ${Math.round((Date.now() - latestEndMs) / 1000)}s 前,重连窗内等待(防第二场撞 key/防拆场)`);
          continue;
        }

        const job = this.ledger.get(b.streamKey);

        // Skip terminal states.
        if (job?.state === "done" || job?.state === "needs_manual") continue;

        // failed 且已达重试上限 → 升级 needs_manual(终态)+ 通知一次人工,不再重入。
        const failedNodes = job?.state === "failed" ? this.ledger.getFailedNodes(b.streamKey) : [];
        // 上传类节点失败不可自动重试(可能已建稿/已 append 部分分 P)→ 直接转人工,避免重复稿。
        const unsafeRetry = failedNodes.some((n) => UNSAFE_RETRY_NODES.has(n.node));
        if (unsafeRetry) {
          this.ledger.setState(b.streamKey, "needs_manual", { error: job?.error ?? "上传类节点失败,禁止自动重试" });
          this.notify?.({
            kind: "error",
            stage: "同步",
            message: `${b.streamKey} 上传类节点失败(${failedNodes.map((n) => n.node).join(",")}),已转人工(needs_manual)。最后错误:${(job?.error ?? "").slice(0, 200)}`,
          });
          continue;
        }
        if (job?.state === "failed" && (job.fails ?? 0) >= this.maxRetries) {
          this.ledger.setState(b.streamKey, "needs_manual", { error: job.error ?? "达重试上限" });
          this.notify?.({
            kind: "error",
            stage: "同步",
            message: `${b.streamKey} 上传重试 ${job.fails} 次仍失败,已转人工(needs_manual)。最后错误:${(job.error ?? "").slice(0, 200)}`,
          });
          continue;
        }

        const { isNew } = this.ledger.upsertPending(b.streamKey, b.startMs);

        // 新建 job(同一场只一次)→ 通知「hub 任务开始」(站内 toast + 全局 webhook)。
        if (isNew) {
          this.notify?.({
            kind: "hubTaskStart",
            streamKey: b.streamKey,
            room: b.roomSlug,
            workers: b.members.map((m) => m.workerId),
            mode: cfg.uploadMode,
          });
        }

        // Don't re-enter an in-progress job unless it was retryable.
        if (!isNew && job && !RETRYABLE.has(job.state)) continue;

        await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
      } catch (err) {
        // Per-broadcast 出错:置 job=failed(可见 + 重试上限内自动重试),不中止其余 broadcast。
        console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
        this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
      }
    }
  }
}
