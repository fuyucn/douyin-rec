import { abortJob, isJobAbort, isJobLive, resolveDiskMinGB, USER_STOP } from "@drec/core";
import type { Transport, NodeInventory } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { PipelineDeps, PipelineCfg } from "./pipeline.js";
import { runPipeline } from "./pipeline.js";
import { clusterBroadcasts, type Broadcast } from "./identity.js";
import { gateWorkers, explainRejections, isWorkerAssigned, isWorkerTargeted } from "@drec/core";
import { JobDispatcher } from "./job-dispatcher.js";

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
  /** 节点连续多少轮清单失联(超时/报错)后发一次「节点失联」通知。默认 6;<=0 关闭。 */
  unreachableAlertRounds?: number;
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
  /**
   * 磁盘看门狗阈值(GB):节点数据根剩余低于此值 → master 发告警。0/负 = 关闭。默认 10。
   * 目的:worker 常不配 DISCORD_WEBHOOK(告警发不出去),由 master 统一兜底 → 防爆盘无人知。
   */
  diskMinGB?: number;
  /** 达重试上限升级 needs_manual 时发一次通知(webhook/UI)。省略 → 只转状态不通知。 */
  notify?: (e: import("@drec/core").NotifyEvent) => void;
  /**
   * 取某 worker 的能力标签(能力门控用)。配合规则 `requires` 过滤成员:能力不满足的房间要求
   * → 该 worker 不参与本场。省略 → 视为所有 worker 无能力(只对写了 requires 的规则有影响)。
   */
  workerCapabilities?: (workerId: string) => string[] | undefined;
  /**
   * 实时重载(Approach A):每轮 reconcileAll 开头调用重建 transports Map。
   * 无状态 transport 重建极廉价。省略 → 用构造时的 transports(旧行为/测试)。
   */
  loadTransports?: () => Map<string, Transport>;
  /**
   * T12:同一场两次「上传后收尾补跑」的最小间隔(ms,默认 15 分钟)。用于节流持续性清理故障
   * (磁盘满 / ssh 不通 / 权限不足)—— 每轮对账重试只会刷屏且无收益。
   */
  cleanupBackfillThrottleMs?: number;
  /**
   * T7:跨房间的**调度**并发上限(同时派发几场的 pull/merge/burn/upload 流程)。
   * 缺省 2。不等于 CPU 并行度 —— merge/burn 仍由 ResourcePool 的 maxCpuParallel
   * 闸住(缺省 1 = 串行),上传链全局串行是设计如此(防 601)。
   */
  maxConcurrentPipelines?: number;
  /**
   * 并发上限的**热读取值器**(T15):传函数则每轮对账取当前值,UI 改完立即生效。
   * 与 `maxConcurrentPipelines` 二选一,getter 优先(它是唯一「唯一消费点」)。
   */
  maxConcurrentPipelinesLive?: () => number;
}

const DEFAULT_SETTLE: SettleConfig = { maxWaitMs: 600_000, pollMs: 15_000 };
const DEFAULT_INVENTORY_TIMEOUT_MS = 60_000;
const DEFAULT_UNREACHABLE_ALERT_ROUNDS = 6;

/**
 * 单节点清单结果三态:ok=有录像;empty=可达但确实没录像;unreachable=超时/报错(**不知道**有没有)。
 * unreachable 绝不能当 empty —— 否则会拿剩余节点错误选优、推进、删源。
 */
export type InventoryResult =
  | { status: "ok" | "empty"; workerId: string; recordings: NodeInventory["recordings"] }
  | { status: "unreachable"; workerId: string; recordings: []; reason: string };
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_STALE_MS = 600_000;
const DEFAULT_RECONNECT_WINDOW_MS = 10 * 60_000;
const DEFAULT_CLEANUP_BACKFILL_THROTTLE_MS = 15 * 60_000;
const DEFAULT_MAX_CONCURRENT_PIPELINES = 2;
const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RETRYABLE = new Set<JobState>(["pending", "failed"]);
const UNSAFE_RETRY_NODES = new Set(["upload_plain", "append_danmu", "append_livechat"]);

/** 收尾补跑日志(统一前缀,便于 grep)。 */
const jlogInfo = (msg: string): void => console.info(msg);

/** 收尾待补的节点:清理失败(clean_*) 与核验待重试(clean_verify=pending)。 */
const CLEANUP_BACKFILL_NODES = new Set(["clean_source", "clean_stage_src", "clean_stage"]);

export class Reconciler {
  private platform: string;
  private transports: Map<string, Transport>;
  private ledger: SyncLedger;
  private pipelineDeps: PipelineDeps;
  private _runPipeline: typeof runPipeline;
  private settle: SettleConfig;
  private sleep: (ms: number) => Promise<void>;
  private inventoryTimeoutMs: number;
  private unreachableAlertRounds: number;
  /** 节点 → 连续失联轮数(仅 reconcileAll 每轮更新一次;恢复即清零)。 */
  private readonly unreachableStreak = new Map<string, number>();
  /** 已发过「失联」通知的节点(恢复后复位 → 再次失联可再报),保证一次失联期只发一条。 */
  private readonly unreachableAlerted = new Set<string>();
  private maxRetries: number;
  private staleMs: number;
  private reconnectWindowMs: number;
  /** 磁盘看门狗:节点数据根剩余 < 阈值(GB) → 告警。0/负 = 关闭。缺省 10。 */
  private diskMinGB: number;
  private notify?: (e: import("@drec/core").NotifyEvent) => void;
  private resolveCfg?: (platform: string, roomSlug: string) => PipelineCfg | null;
  private workerCapabilities?: (workerId: string) => string[] | undefined;
  private loadTransports?: () => Map<string, Transport>;
  /** 已警告过「显式 workers 过滤后无成员」的 streamKey(幽灵 worker id),避免每轮刷屏。 */
  private readonly warnedGhostWorkers = new Set<string>();
  /** 已警告过「能力门控过滤后无成员」的 streamKey,避免每轮刷屏。 */
  private readonly warnedCapabilityWorkers = new Set<string>();
  /** 已告警过的低磁盘节点 id(回升后复位,避免每轮刷屏)。 */
  private readonly diskAlerted = new Set<string>();
  /** T12:同一场两次收尾补跑的最小间隔(ms);持续性故障(磁盘满/ssh 不通)不该每轮重试。 */
  private cleanupBackfillThrottleMs: number;
  /**
   * T7:有界并发派发器。作为**实例字段**(不是每次 reconcileAll 新建)——
   * 活动 key 集合必须跨调用存活,否则并发跑的两轮 reconcileAll 各自去重,
   * 同一场会被派发两次(withStreamLock 只串行不 dedup → 重复投稿 P1)。
   */
  private readonly dispatcher: JobDispatcher;

  constructor(deps: ReconcilerDeps) {
    this.platform = deps.platform;
    this.transports = deps.transports;
    this.ledger = deps.ledger;
    this.pipelineDeps = deps.pipelineDeps;
    this._runPipeline = deps.runPipeline ?? runPipeline;
    this.settle = deps.settle ?? DEFAULT_SETTLE;
    this.sleep = deps.sleep ?? DEFAULT_SLEEP;
    this.inventoryTimeoutMs = deps.inventoryTimeoutMs ?? DEFAULT_INVENTORY_TIMEOUT_MS;
    this.unreachableAlertRounds = deps.unreachableAlertRounds ?? DEFAULT_UNREACHABLE_ALERT_ROUNDS;
    this.maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
    this.reconnectWindowMs = deps.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    // 与 daemon / 上传闸门同一解析(core):缺省 10、非数字回落 10 并告警、<=0 关闭。
    this.diskMinGB = resolveDiskMinGB(deps.diskMinGB, (m) => console.warn(m)).gb;
    this.notify = deps.notify;
    this.resolveCfg = deps.resolveCfg;
    this.workerCapabilities = deps.workerCapabilities;
    this.loadTransports = deps.loadTransports;
    this.cleanupBackfillThrottleMs = deps.cleanupBackfillThrottleMs ?? DEFAULT_CLEANUP_BACKFILL_THROTTLE_MS;
    this.dispatcher = new JobDispatcher({
      maxConcurrent: deps.maxConcurrentPipelines ?? DEFAULT_MAX_CONCURRENT_PIPELINES,
      // 热读优先:没传 getter 才用上面的静态值(T7 行为不变)。
      ...(deps.maxConcurrentPipelinesLive
        ? { maxConcurrentLive: deps.maxConcurrentPipelinesLive }
        : {}),
      log: (m) => jlogInfo(m),
    });
  }

  /** 调度并发上限(只读,便于测试/诊断)。 */
  get maxConcurrentPipelines(): number {
    return this.dispatcher.maxConcurrent;
  }

  /**
   * 磁盘看门狗:并发查各节点数据根剩余空间,低于 diskMinGB 时由 **master** 发告警
   * (`notify({kind:"error",stage:"磁盘"})`)。每节点只在「进入低水位」时报一次,回升复位。
   * 任何失败(transport 无此能力 / ssh 不通)静默跳过 —— 看门狗绝不反噬主流程。
   */
  private async checkDiskSpace(transports: Map<string, Transport>): Promise<void> {
    if (this.diskMinGB <= 0) return;
    await Promise.all([...transports.values()].map(async (t) => {
      if (!t.diskFreeGB) return;
      let freeGB: number;
      try {
        freeGB = await t.diskFreeGB();
      } catch {
        return; // 查不到(不支持/网络问题)→ 跳过,不误报
      }
      if (!Number.isFinite(freeGB)) return;
      if (freeGB < this.diskMinGB) {
        if (!this.diskAlerted.has(t.id)) {
          this.diskAlerted.add(t.id);
          this.notify?.({
            kind: "error",
            stage: "磁盘",
            message: `节点 ${t.id} 剩余 ${freeGB.toFixed(1)}GB,低于阈值 ${this.diskMinGB}GB —— 继续录制可能写满导致损坏,pull/清理后恢复`,
          });
        }
      } else {
        this.diskAlerted.delete(t.id);
      }
    }));
  }

  /**
   * listInventory 包超时,返回三态:挂起超过 inventoryTimeoutMs 或 reject → unreachable
   * (该节点本轮「不知道有没有录像」,不是「没录像」);正常返回按有无录像分 ok / empty。
   */
  private async inventoryWithTimeout(t: Transport): Promise<InventoryResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<InventoryResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: "unreachable", workerId: t.id, recordings: [], reason: `listInventory 超时 ${this.inventoryTimeoutMs}ms` });
      }, this.inventoryTimeoutMs);
    });
    try {
      return await Promise.race([
        (async (): Promise<InventoryResult> => {
          try {
            const inv = await t.listInventory();
            return { status: inv.recordings.length > 0 ? "ok" : "empty", workerId: t.id, recordings: inv.recordings };
          } catch (err) {
            return { status: "unreachable", workerId: t.id, recordings: [], reason: String((err as Error)?.message ?? err).slice(0, 200) };
          }
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 本场「规则选中」的节点里当前失联的那些(未被规则选中的节点失联不影响本场)。
   * 选中集 = cfg.workers(显式非空)或全部 transport,再按 requires 能力门控过滤 —— 与成员过滤同口径。
   */
  private blockingUnreachable(
    cfg: PipelineCfg,
    transports: Map<string, Transport>,
    unreachable: Map<string, string>,
  ): string[] {
    if (unreachable.size === 0) return [];
    let ids = cfg.workers?.length ? cfg.workers : [...transports.keys()];
    ids = ids.filter((id) => unreachable.has(id));
    // 选中 ∧ 能力满足:与 master 下发同一判定(core isWorkerAssigned;cfg 无 enabled → 视为启用)。
    return ids.filter((id) => isWorkerAssigned(cfg, id, this.workerCapabilities?.(id)));
  }

  /** 每轮对账更新一次失联轮数;连续达阈值发一条通知(只通知,不转人工、不删任何东西)。 */
  private trackUnreachable(transports: Map<string, Transport>, unreachable: Map<string, string>): void {
    for (const id of [...this.unreachableStreak.keys()]) {
      if (!transports.has(id) || !unreachable.has(id)) {
        this.unreachableStreak.delete(id);
        this.unreachableAlerted.delete(id);
      }
    }
    for (const [id, reason] of unreachable) {
      const n = (this.unreachableStreak.get(id) ?? 0) + 1;
      this.unreachableStreak.set(id, n);
      if (this.unreachableAlertRounds > 0 && n >= this.unreachableAlertRounds && !this.unreachableAlerted.has(id)) {
        this.unreachableAlerted.add(id);
        this.notify?.({
          kind: "error",
          stage: "同步",
          message: `节点 ${id} 清单已连续 ${n} 轮失联(${reason}),涉及该节点的场暂停选优/收口,恢复后自动继续`,
        });
      }
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
   * 1. Concurrently fetch all inventories; 超时/报错的节点标 unreachable(不当空清单,
   *    不锁死整轮、不中止其余节点),由调用方决定涉及它的场如何处理。
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
    /** 本轮清单失联的节点 id → 原因(超时/报错)。 */
    unreachable: Map<string, string>;
  }> {
    const invs = await Promise.all(
      [...transports.values()].map((t) => this.inventoryWithTimeout(t)),
    );
    const unreachable = new Map<string, string>();
    for (const i of invs) {
      if (i.status !== "unreachable") continue;
      unreachable.set(i.workerId, i.reason);
      console.warn(`[reconciler] worker ${i.workerId} 清单失联(${i.reason}),不当作「无录像」;涉及它的场本轮不选优`);
    }

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
        const before = b.members.length;
        b.members = b.members.filter((m) => isWorkerTargeted(cfg, m.workerId));
        // 显式勾选却过滤到一个不剩:通常是规则里留着已删除的 worker id(API 已禁止新增/删除引用,
        // 但手改文件绕过)。不静默 —— 否则表现为「录了却永远不合并/上传」。每个 streamKey 只报一次。
        if (before > 0 && b.members.length === 0 && !this.warnedGhostWorkers.has(b.streamKey)) {
          this.warnedGhostWorkers.add(b.streamKey);
          console.warn(
            `[reconciler] ${b.streamKey} 的规则 workers=[${cfg.workers.join(", ")}] 在节点清单里没有对应成员` +
              `(疑似已删除的 worker id),本场不会进入后处理 —— 请检查该房间的 hub 规则。`,
          );
        }
      }
      // 能力门控:房间要求的能力(requires)未满足的 worker 不参与本场。
      // 与 workers 勾选取交集 —— 只做过滤,不做去重,不改变「多节点冗余录制」语义。
      if (cfg.requires?.length) {
        const before = b.members.length;
        const { eligible, rejected } = gateWorkers(
          b.members.map((m) => m.workerId),
          (id) => this.workerCapabilities?.(id),
          cfg.requires,
        );
        const keep = new Set(eligible);
        b.members = b.members.filter((m) => keep.has(m.workerId));
        // 有人被能力门控排除、且过滤后一个不剩 → 不静默(否则表现为「录了却永远不合并/上传」)。
        if (before > 0 && b.members.length === 0 && !this.warnedCapabilityWorkers.has(b.streamKey)) {
          this.warnedCapabilityWorkers.add(b.streamKey);
          console.warn(
            `[reconciler] ${b.streamKey} 需要能力 [${cfg.requires.join(", ")}],` +
              `${explainRejections(rejected, (id) => id)} —— 本场不会进入后处理,请检查 hub 规则/worker 能力配置。`,
          );
        }
      }
      cfgByKey.set(b.streamKey, cfg);   // 过滤后仍有/无成员都缓存;空成员在循环里跳过
    }
    return { broadcasts, cfgByKey, unreachable };
  }


/**
 * T12:该 job 是否**到点该补跑收尾**(清理失败 / 核验软状态)。
 *
 * 节流:同一场两次补跑之间至少 `cleanupBackfillThrottleMs`(默认 15 分钟)——
 * 清理失败往往是「磁盘满 / 节点 ssh 不通 / 权限」这类**持续性**故障,每 30 分钟对账轮
 * 反复重试只会刷屏且无收益。
 *
 * @returns 可补跑的节点名(供日志);null = 无需补跑。
 */
private cleanupBackfillDue(streamKey: string, sourceAfterDone?: boolean): string | null {
  const nodes = this.ledger.getNodeStates(streamKey);
  const now = Date.now();
  const due: string[] = [];
  for (const n of nodes) {
    const isVerify = n.node === "clean_verify";
    const matches = isVerify ? n.state === "pending" : (CLEANUP_BACKFILL_NODES.has(n.node) && n.state === "failed");
    if (!matches) continue;
    // `Math.max(0, ...)`:台账的 now() 是**进程内单调递增**(同毫秒多次调用会 +1 递推),
    // 而这里用 Date.now() 读墙钟 → 同一 tick 内 `Date.now() - updatedAt` 可能是**负数**
    // (updatedAt 是未来 1ms 的递推值)。不夹到 0 的话,throttleMs=0 也会被当成「刚失败」而跳过。
    const age = Math.max(0, now - n.updatedAt);
    if (age < this.cleanupBackfillThrottleMs) continue;
    due.push(n.node);
  }
  // ⚠️ **已撤回**「done + clean_source 缺失 → 补跑」这条(2026-10-11 实测发现它有害)。
  //
  // 原本想用它回收「上传成功却没删源」的积压(实测 ~28G,撑爆过磁盘)。但实测发现:
  // 补跑走的是 **整条 runPipeline**,不是「只删源」。对 `mergeSegments=false` 的房间会走
  // `runSegmentPipeline`,那条路径在 `existing?.bv` 时仍**先 select + pull 源回 stage**
  // (实测正把 14G 从节点拉回 master)→ ①磁盘不降反升 ②存在**重复 append / 重复投稿**风险。
  // 「为了省空间反而更费空间、还可能重传」—— 必须撤回,不能留着。
  //
  // 正确做法(留 T33 后续):删源**不该借道 pipeline**,应有一个**只删源、不做 select/pull/
  // append/上传**的独立收尾入口(或 pipeline 支持「只跑 cleanup」的收尾模式)。
  // 在那之前,积压源录像**保持现状**(安全第一:源不能因为清理动作本身被重复上传)。
  void sourceAfterDone;
  return due.length > 0 ? due.join(",") : null;
}

  async reconcileAll(): Promise<void> {
    // 实时重载:重建 transports(反映 hub.config.json 最新 workers);同步给 pipeline 用的那份。
    if (this.loadTransports) this.transports = this.loadTransports();
    const transports = this.transports;
    // 磁盘看门狗:每轮对账顺带查各节点剩余空间 → 低了由 **master 自己**告警。
    // 不依赖 worker 侧 DISCORD_WEBHOOK(worker 常不配,告警发不出去 → 爆盘无人知)。
    // 与主流程并行、不阻塞:查不到(transport 不支持/ssh 失败)就跳过该节点。
    void this.checkDiskSpace(transports);
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
    const { broadcasts, cfgByKey, unreachable } = await this.collect(transports, this.ledger.listKeys());
    this.trackUnreachable(transports, unreachable);

    // 3.5 第一份快照之后才出现的成员没经过 settle 等待(典型:首快照为空 → settle 秒回 →
    // 第二份快照才发现刚开播的分段)。现查 isDone,未收播则本轮跳过,防边录边合并残片。
    await this.settleLateMembers(first.broadcasts, broadcasts, stillRecording);

    // 4. For each broadcast: 建 job 行(快)→ 派发给有界并发调度器(慢 IO 在那边)。
    //
    // T7 两阶段:旧实现是在这个循环里 `await this._runPipeline(b, …)`,于是**房间 N+1 的
    // job 行要等房间 N 的 merge/burn/upload 全跑完才创建**(队列/UI 假死),后一场的
    // pull(网络 IO)也没机会与前一场的 CPU 编码重叠。现在 ①同步建全部 job 行;
    // ②执行交给 JobDispatcher 有界并发。
    //
    // `await dispatcher.drain()` **保留在本方法内**:startHub 的 running 守卫只覆盖
    // reconcileAll 返回前的 promise;提前返回会让 recordEnd 触发的下一轮重复派发
    // 「state 还是 pending」的房间(withStreamLock 只串行不 dedup → 同一场跑两次 = 重复投稿 P1)。
    // 赢的是**跨房间并发派发**,不是「提前返回」。
    //
    // 诚实边界:ResourcePool 的 maxCpuParallel 缺省仍是 1 → merge/burn **依旧串行**;
    // 上传链全局串行是设计如此(防 601)。T7 真正交付的是「后一场的 job 行立即可见」
    // + 后一场的 pull/net/upload 可与前一场的 CPU 工作重叠。
    const dispatched: Promise<void>[] = [];
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

        // T12 补跑:done 但「清理失败 / 核验待重试」的 job —— **在终态短路之前**判定,
        // 否则永远看不到这些 job(它们已经是终态,不会走下面的失败重试逻辑)。
        // 复用 pipeline 已有的幂等续跑(bv 已在库 → 只补 append + 收尾闸门),
        // 成员清单来自本轮 inventory —— 清理失败的源文件**仍在节点上**(没删成),故能被扫到。
        if (job?.state === "done") {
          // sourceAfterDone 从**该房间当前配置**读:没开清理就不该补删源(与 cleanupSources 同口径)。
          const due = this.cleanupBackfillDue(b.streamKey, cfg.cleanup?.sourceAfterDone === true);
          if (due) {
            jlogInfo(`[reconciler] ${b.streamKey} 上传后收尾未完成(${due}) → 补跑`);
            // 也派发出去(收尾补跑同样是长 IO)—— 失败**不改终态**:上传已成功,
            // 不该把 job 打成 failed(会诱导重传 = 重复稿)。只记日志 + 下轮再来。
            dispatched.push(this.dispatcher.dispatch(b.streamKey, async () => {
              try {
                await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
              } catch (err) {
                if (isJobAbort(err)) { this.ledger.setState(b.streamKey, "needs_manual", { error: USER_STOP }); return; }
                console.error(`[reconciler] ${b.streamKey} 收尾补跑失败:`, err);
              }
            }));
          }
          continue;
        }

        // Skip terminal states(needs_manual 属人工决策,reconciler 不自动推进)。
        if (job?.state === "needs_manual") continue;

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

        // 三态:规则选中的节点里有失联的 → 本场不知道缺了谁的录像,选优可能选错 → 本轮跳过选优与收口,
        // 下一轮重试。放在 done/needs_manual 短路之后(已收口的场不受影响)、建 job 之前(不留半截状态)。
        const lost = this.blockingUnreachable(cfg, transports, unreachable);
        if (lost.length > 0) {
          console.warn(
            `[reconciler] ${b.streamKey} 参与节点 ${lost.map((id) => `${id}(${unreachable.get(id)})`).join(", ")} 清单失联,` +
              `本轮跳过选优与收口,下轮重试`,
          );
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

        // 执行阶段:有界并发派发(同 key 活动去重 → 同一场永不并发、不重复建稿)。
        // 失败语义**必须随执行一起搬进派发闭包**:旧实现在循环的 try/catch 里 markFailed,
        // 一旦把 await 挪进 dispatcher 就落到 dispatcher 的兜底日志上 → job 卡在
        // pending/retrying 且不计入 fails,重试上限形同虚设。所以在这里自己处理。
        const settled = this.dispatcher.dispatch(b.streamKey, async () => {
          try {
            await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
          } catch (err) {
            // 用户停止 → 转人工,绝不能 markFailed(failed 会自动重试)。
            if (isJobAbort(err)) {
              this.ledger.setState(b.streamKey, "needs_manual", { error: USER_STOP });
              return;
            }
            // Per-broadcast 出错:置 job=failed(可见 + 重试上限内自动重试),不中止其余 broadcast。
            console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
            this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
          }
        });
        // 去重命中时 dispatch 返回 resolved promise(活动 key 已在跑,本轮不必等它)——
        // dispatcher 内部已打日志说明跳过,不静默。
        dispatched.push(settled);
      } catch (err) {
        // 下面这层 catch 现在只覆盖「建 job / 判定阶段」的异常(执行期异常已在派发闭包内处理)。
        // 用户停止 → 转人工,绝不能 markFailed(failed 会自动重试)。
        if (isJobAbort(err)) {
          this.ledger.setState(b.streamKey, "needs_manual", { error: USER_STOP });
          continue;
        }
        // Per-broadcast 出错:置 job=failed(可见 + 重试上限内自动重试),不中止其余 broadcast。
        console.error(`[reconciler] broadcast ${b.streamKey} failed:`, err);
        this.ledger.markFailed(b.streamKey, String((err as Error)?.message ?? err).slice(0, 300));
      }
    }
    // 等**本轮派发出去**的场全部跑完(保留 running 守卫语义,见上方说明)。
    // 只等自己派发的那些:并发进来的另一轮所派的活跟本轮无关,不该把本轮卡住。
    await Promise.all(dispatched);
  }

  /**
   * 停一场后处理(rsync/ffmpeg/biliup),不动录制。
   * 无 job → 200 且不建行;done → 409;已 needs_manual → 200。
   * 空闲 pending/failed 也标 needs_manual,否则 reconciler 会按 RETRYABLE 重入。
   */
  async stopJob(streamKey: string): Promise<{ ok: boolean; error?: string; code?: number }> {
    const job = this.ledger.get(streamKey);
    if (!job) return { ok: true };
    if (job.state === "done") return { ok: false, error: "已完成,不能停止", code: 409 };
    if (job.state === "needs_manual") return { ok: true };
    abortJob(streamKey); // 非 live → false,不留 aborted 痕迹
    this.ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
    return { ok: true };
  }

  /**
   * 立刻跑一场已有录像的后处理:跳过 settle / 断流重连窗。
   * wait 默认 false → 点火后返回 202。
   */
  async runNow(opts: {
    streamKey: string;
    winnerWorker?: string;
    wait?: boolean;
  }): Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string }> {
    const streamKey = opts.streamKey?.trim() ?? "";
    if (!streamKey) return { ok: false, error: "streamKey 必填", code: 400 };
    const wait = opts.wait === true;
    const winnerWorker = opts.winnerWorker?.trim() || undefined;

    if (this.loadTransports) this.transports = this.loadTransports();
    const transports = this.transports;
    const { broadcasts, cfgByKey } = await this.collect(transports, this.ledger.listKeys());
    // 新建任务(UI 用 -1/-2 后缀):录像身份仍是 base key,但 job/stage 用带后缀的新 key,
    // 这样每次「立即执行」都是独立 hub 任务,不会续跑旧任务。
    // 注意不能用裸 /-\d+$/ 判断:日期本身以 -DD 结尾(2026-08-27 会误判成 -27 后缀)。
    const newSub = /^(.+?:\d{4}-\d{2}-\d{2}(?:_\d{4})?)-(\d+)$/.exec(streamKey);
    const isNewSubmission = newSub != null;
    const baseKey = isNewSubmission ? newSub![1] : streamKey;
    const found = pickBroadcast(broadcasts, baseKey);
    if (!found || found.members.length === 0) {
      return { ok: false, error: `没有可跑的录像: ${baseKey}`, code: 404 };
    }

    const members = winnerWorker
      ? found.members.filter((m) => m.workerId === winnerWorker)
      : found.members.slice();
    if (members.length === 0) {
      return { ok: false, error: `节点 ${winnerWorker} 没有这场录像`, code: 404 };
    }
    const b: Broadcast = { ...found, streamKey: isNewSubmission ? streamKey : found.streamKey, members };
    const key = b.streamKey;
    if (isJobLive(key) || (this.pipelineDeps.pool?.hasStreamLock(key) ?? false)) {
      return { ok: false, error: "任务正在执行", code: 409 };
    }
    const job = this.ledger.get(key);
    if (job?.state === "done" && job.bv) {
      return { ok: false, error: `已完成(${job.bv}),不能重跑`, code: 409 };
    }

    this.ledger.upsertPending(key, b.startMs);
    this.ledger.resetActiveNodes(key);
    this.ledger.setState(key, "retrying", {}, { force: true }); // 人工重跑:允许把 done(无 bv)拨回进行中

    // 配置按广播身份(found.streamKey)缓存;新建任务 key 带 -N 后缀,直接按任务 key 查会
    // miss 而回落成全局 stage 默认 → 上传节点全 skip。必须按 found 的原始广播身份查。
    const cfg = cfgByKey.get(found.streamKey) ?? cfgByKey.get(key) ?? this.pipelineDeps.cfg;
    const fire = async (): Promise<void> => {
      try {
        await this._runPipeline(b, { ...this.pipelineDeps, transports, cfg });
      } catch (err) {
        if (isJobAbort(err)) {
          this.ledger.setState(key, "needs_manual", { error: USER_STOP });
          return;
        }
        console.error(`[reconciler] runNow ${key} failed:`, err);
        this.ledger.markFailed(key, String((err as Error)?.message ?? err).slice(0, 300));
        if (wait) throw err;
      }
    };
    if (wait) {
      try {
        await fire();
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300), code: 500, streamKey: key };
      }
      return { ok: true, code: 200, streamKey: key };
    }
    void fire();
    return { ok: true, code: 202, streamKey: key };
  }
}

/** 精确 key 优先;否则同日前缀 `_HHMM`;多场取 startMs 最新。 */
function pickBroadcast(broadcasts: Broadcast[], streamKey: string): Broadcast | undefined {
  const exact = broadcasts.find((b) => b.streamKey === streamKey);
  if (exact) return exact;
  const prefix = `${streamKey}_`;
  const matches = broadcasts.filter((b) => b.streamKey.startsWith(prefix));
  if (matches.length === 0) return undefined;
  return matches.reduce((a, b) => (a.startMs >= b.startMs ? a : b));
}
