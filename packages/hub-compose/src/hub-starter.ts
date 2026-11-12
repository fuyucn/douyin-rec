/**
 * Hub starter assembly: the multi-node orchestration body that used to live inline in the CLI.
 *
 * Moved here unchanged (plan 050.1). The CLI keeps only the injection site; behaviour, return
 * contracts and the web-side 400/409 judgements stay exactly as they were.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  APP_VERSION, effectiveTimezone, readManagedState, readOutputLayout,
  resolveHubConfig, rootStatsDbPath,
} from "@drec/app";
import type { HubStarter } from "@drec/app";
import type { PipelineCfg, WorkflowNodeKey } from "@drec/orchestrator";
import { createBiliupFileTarget } from "@drec/bilibili-upload";
import {
  burnFlags, closeStageReady, effectiveStageFormat, isJobAbort, isJobLive, isUploadingMode,
  listProcessors, normalizeSeasonSectionId, platformForRoom, registerChild,
  resolveDiskMinGB, resolveJobLogPath, resolveSeasonSectionId, runWithJob, stageSessionDir,
  throwIfAborted, ttlMemoAsync, USER_STOP,
} from "@drec/core";
import type { EnqueueRequest, HubResources, RecordingWorkerStatusDTO, RemoteTaskSpec, RollingDeliveryDTO, WorkerStatus } from "@drec/core";
import {
  fleetLink, fleetUpgrade, getReceiptSettings, hubSyncGate, PROBE_CACHE_MS, readBlockedBroadcasts,
  readPoolSnapshot, readRecordingWorkers, readRollingDelivery, readZeroDiskLive, readZeroDiskStatus,
  recordingSnapshotKey, recordingSnapshotValues, requestHubAckJob, requestHubProbeDrainSupport,
  requestHubRetryNode, requestHubRunNow, requestHubStopJob, requestHubSync, requestNodeTaskLogs,
  requestNodeTasks, requestNotifyOutbox, setAckJob, setDeliverySnapshot, setFleetController,
  setPoolProviders, setProbeDrainSupport, setRecordingSnapshot, setRetryNode, setRunNow, setStopJob,
  setSyncTasks, setZeroDiskLive, setReceiptSettings, stopFleet,
  warnRuleIdentityMismatch,
} from "./hub-runtime.js";
import { createCookieSync } from "./cookie-sync.js";
import { createTaskSync } from "./task-sync.js";
import { createZeroDiskSync } from "./zero-disk-sync.js";

export interface LocalRoomProbeFallback {
  isRoomRecording(roomSlug: string): boolean;
  activeRecordingRooms(): Array<{ platform: string; roomSlug: string }>;
}

/** Everything the starter needs that the CLI still owns. */
export interface HubStarterDeps {
  localRoomProbes: (
    dataRoot: () => string,
    deps: unknown,
    fallback: LocalRoomProbeFallback,
  ) => LocalRoomProbeFallback;
  masterUploadAccountKey: (warn: (m: string) => void) => string;
}

export function createHubStarter(deps: HubStarterDeps): HubStarter {
  const hubStarter: HubStarter = {
    fleetUpgrade: (req, socket, head) => fleetUpgrade(req, socket, head),
    requestSyncTasks: requestHubSync,
    probeDrainSupport: requestHubProbeDrainSupport,
    recordingWorkers: readRecordingWorkers,
    zeroDiskStatus: readZeroDiskStatus,
    readZeroDiskLive,
    nodeTaskLogs: requestNodeTaskLogs,
    nodeTasks: requestNodeTasks,
    notifyOutbox: requestNotifyOutbox,
    rollingDelivery: readRollingDelivery,
    blockedBroadcasts: readBlockedBroadcasts,
    poolSnapshot: readPoolSnapshot,
    retryNode: requestHubRetryNode,
    stopJob: requestHubStopJob,
    ackJob: requestHubAckJob,
    runNow: requestHubRunNow,
    async start(opts) {
      setReceiptSettings(opts.store);
      const {
        registerBuiltinTransports, Reconciler, SyncLedger, startHub, getTransport, recordingStatusWorkerIds,
        satisfiesCapabilities, blockedKey,
        buildWorkflow, runWorkflowNodes, deriveStageProducts, withOutputStem, ResourcePool, openUploadLimitStore,
        parseNodeUploadConfig } = await import("@drec/orchestrator");
      const { ffprobeVideo } = await import("@drec/post-process");
      const { handleEnqueue, handleProcStatus, handleProcCancel } = await import("@drec/app");
      const { statSync } = await import("node:fs");
      const { countVideoParts, hubStore, resolveRuleSyncRoom, desiredSpecsForWorker, workerStore, rootHubDir, rootHubConfig, rootConfigDir, rootStageDir, rootLogsDir, drecRoot, listNodeTasks, applyRemoteTasks, recordRoomSessions } = await import("@drec/app");
      const { FileLogger } = await import("@drec/observability");
      // Platform login push (issue #563): one instance per start(), so its dedupe sets live as
      // long as this hub does. It has to run before task sync - see cookie-sync.ts.
      const cookieSync = createCookieSync({ store: opts.store, warn: opts.warn, log: opts.log });

      const hubCfg = JSON.parse(opts.hubConfigJson ?? "null") as null | {
        platform?: string;
        workers?: Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }>;
        /** 旧字段名(迁移兼容,读时 `workers ?? tenants`)。 */
        tenants?: Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }>;
        settleMs?: number;
        pollMs?: number;
        reconcileIntervalMs?: number;
        /** hub 任务同步周期(ms);缺省 60_000。 */
        syncIntervalMs?: number;
        stageDir?: string;
        cookies?: string;
        cleanMaxGapSec?: number;
        /** Reconnect wait window (ms); defaults to core `SAME_BROADCAST_GAP_MS` (30 min). */
        reconnectWindowMs?: number;
        /** Consecutive unreachable rounds after which a blocked broadcast turns needs_manual; default 12, <=0 disables. */
        blockedManualRounds?: number;
        /** 上传后延后回读分 P 数的总窗口(ms);缺省 10 分钟。主控路径删最后一份源之前必须回读一致,否则保留源并转人工(issues #92 / #327)。 */
        sideCheckDelayMs?: number;
        /** 投稿默认(per-task 文件留空时回退);旧字段 uploadMeta 也认(迁移兼容)。 */
        uploadDefaults?: { tag?: string; tid?: number; desc?: string; titleTemplate?: string; submissionTitleTemplate?: string; partTitleTemplate?: string; seasonSectionId?: number };
        uploadMeta?: { tag?: string; tid?: number; desc?: string; titleTemplate?: string; submissionTitleTemplate?: string; partTitleTemplate?: string; seasonSectionId?: number };
        /** Max settle wait before reconciler proceeds regardless (seconds). */
        maxWaitSec?: number;
        /** Settle poll interval (seconds). */
        settleSec?: number;
        /** 资源池 / 崩溃恢复安全阀。缺省:cpu/net 各 1、内存闸门 烧录 1024MB · 合并 512MB · 600s 后告警、stale 600s。 */
        resources?: {
          maxCpuParallel?: number;
          maxNetParallel?: number;
          minBurnFreeMemMB?: number;
          minMergeFreeMemMB?: number;
          memWaitTimeoutMs?: number;
          staleMs?: number;
          /** T7:跨房间的调度并发上限(同时派发几场后处理流程)。缺省 2;与 maxCpuParallel 无关。 */
          maxConcurrentPipelines?: number;
          /** 磁盘看门狗阈值(GB):节点数据根剩余低于此值 → master 告警。缺省 10,0=关。 */
          diskMinGB?: number;
          /** 全局上传队列:B 站按提交次数限流(601)。窗口内最多 uploadRateLimit 次,命中后冷却 uploadCooldownMs。 */
          uploadRateLimit?: number;
          uploadRateWindowMs?: number;
          uploadCooldownMs?: number;
        };
        /**
         * Fleet long connection (plans/042). Opt-in: set `controllerUrl` to this master's address as the
         * workers reach it (tailscale), e.g. "http://<master-tailscale-ip>:7860". Absent → ssh only, as before.
         */
        fleet?: { controllerUrl?: string };
      };
      if (!hubCfg) {
        opts.warn("[hub] --hub 已设置但 --hub-config / settings.hubConfig 未提供，跳过");
        return undefined;
      }

      const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
        const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
        const endMs = statSync(file).mtimeMs;
        return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
      };

      // BUG#2 fix: taskRooms getter — maps both anchorName AND task.name → roomSlug so
      // local node recordings cluster with remote (ssh) nodes that report the numeric roomSlug.
      const buildTaskRooms = (): Record<string, string> => {
        const map: Record<string, string> = {};
        for (const task of opts.store.listTasks()) {
          const slug = platformForRoom(task.room).extractRoomSlug(task.room);
          if (task.name) map[task.name] = slug;
          if (task.anchorName) map[task.anchorName] = slug;
        }
        return map;
      };
      // Lives for the whole serve process: repeated master sync rounds dedupe the legacy
      // no-spool compatibility warning through this set (see task-sync ApplyTasksOptions).
      const noSpoolWarnedKeys = new Set<string>();
      // Local worker: same judgement as ssh / fleet nodes (state files + /proc fallback), NOT the serve-side
      // `[状态]` flag, which flips to "not recording" on `录制停滞` while the tail part is still uploading.
      // Hosts without /proc (macOS) cannot verify state files: there the serve-side flag is the only signal.
      // Dev-only, non-Linux limitation: that flag still flips to "not recording" on `录制停滞` while a tail is
      // uploading (the original #456 stall flip). Production masters run Linux/Docker and never take this path.
      const { isRoomRecording, activeRecordingRooms } = deps.localRoomProbes(drecRoot, undefined, {
        isRoomRecording: (slug) => opts.store.listTasks().some(
          (t) => platformForRoom(t.room).extractRoomSlug(t.room) === slug && opts.manager.isRecording(t.id),
        ),
        activeRecordingRooms: () => opts.store.listTasks().flatMap((t) => {
          if (!opts.manager.isRecording(t.id)) return [];
          const platform = platformForRoom(t.room);
          return [{ platform: platform.id, roomSlug: platform.extractRoomSlug(t.room) }];
        }),
      });
      registerBuiltinTransports({
        ffprobe,
        fleet: fleetLink,
        taskRooms: buildTaskRooms,
        isRoomRecording,
        activeRecordingRooms,
        // local worker = master 自身:hub 任务同步直接落在本机 store(与远端 `_tasks` / `_apply-tasks` 同路径)。
        listTasks: () => listNodeTasks(opts.store),
        // 处理任务表通道(T9a):local worker 与远端 `_enqueue` / `_proc-status` 同一执行体(无派发方,仅可被调用)。
        procChannel: {
          enqueue: (dataRoot, req) => handleEnqueue(dataRoot, req, { capabilities: listProcessors().map((p) => p.kind) }),
          procStatus: (dataRoot, ids) => handleProcStatus(dataRoot, ids),
          procCancel: (dataRoot, ids) => handleProcCancel(dataRoot, ids),
        },
        // adopt=false:本机源任务保持用户可编辑(managedBy 不置 hub),只有远端节点的同步任务才锁编辑。
        applyTasks: (input) => applyRemoteTasks(opts.store, input.desired, opts.log, {
          adopt: false,
          noSpoolWarnedKeys,
          force: input.force === true,
          // 审计快照落 <数据根>/config/managed/(显式传目录,不从 DOUYIN_REC_ROOT 推导)。
          managedStateDir: join(rootConfigDir(), "managed"),
          // T16:本机 worker 也必须记录期望版本,否则状态页只报 unknown。
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        }),
      });

      const workers = hubCfg.workers ?? hubCfg.tenants ?? [];
      // loadWorkers 现读 hub.config.json(现读不缓存→UI/手改即时生效)。首启无文件时回落 --hub-config 里的 workers。
      const loadWorkers = (): Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string; capabilities?: string[] }> => {
        const fromFile = workerStore.listWorkers(rootHubConfig());
        return fromFile.length ? fromFile : workers;
      };
      // Fleet long connection (plans/042): workers dial in; SshTransport consults it before spawning over ssh.
      const fleetControllerUrl = hubCfg.fleet?.controllerUrl?.trim();
      if (fleetControllerUrl) {
        const { startFleetController } = await import("@drec/orchestrator");
        setFleetController(startFleetController({
          controllerUrl: fleetControllerUrl,
          tokenPath: join(rootConfigDir(), "fleet-nodes.json"),
          loadWorkers,
          log: opts.log,
          warn: opts.warn,
          // A worker's recording rooms changed: refresh the console snapshot now (it reads the fresh heartbeat).
          onRecordingChange: () => void refreshRecordingStatus(),
        }));
      }
      let refreshingRecordingStatus = false;
      /** 状态探测与 pipeline 共用同一批 transport 实例(避免每 5s 重建 SshTransport)。 */
      let statusTransports: Map<string, ReturnType<typeof getTransport>> | null = null;
      let statusTransportsFingerprint = "";
      const refreshRecordingStatus = async (): Promise<void> => {
        if (refreshingRecordingStatus) return;
        refreshingRecordingStatus = true;
        try {
          const configuredWorkers = loadWorkers();
          // 只查询「至少被一条绑定源任务的规则选中」的 worker;未被任何规则选中的 worker
          // 没有房间需要展示状态,每 5s 对其发 SSH 纯属浪费。
          const boundWorkerIds = recordingStatusWorkerIds(
            hubStore.listHubRules(rootHubDir()),
            configuredWorkers.map((w) => w.id),
          );
          // worker 配置可能刚被改(增删/换 kind)→ 指纹变了就重建,否则复用。
          const fingerprint = configuredWorkers.map((w) => `${w.id}:${w.kind}:${w.host ?? ""}:${w.dataRoot ?? ""}`).join("|");
          if (!statusTransports || statusTransportsFingerprint !== fingerprint) {
            statusTransports = buildTransports();
            statusTransportsFingerprint = fingerprint;
          }
          const probed = configuredWorkers.filter((w) => boundWorkerIds.has(w.id));
          const results = await Promise.all(probed.map(async (worker) => {
            try {
              const transport = statusTransports!.get(worker.id);
              if (!transport) throw new Error(`未注册的 worker transport: ${worker.id}`);
              if (!transport.activeRecordingRooms) throw new Error("worker 不支持录制状态查询");
              const st = transport.recordingStatus
                ? await transport.recordingStatus()
                : { rooms: await transport.activeRecordingRooms(), rolling: [] };
              return { worker, rooms: st.rooms, rolling: st.rolling, error: null };
            } catch (e) {
              return { worker, rooms: [], rolling: [], error: (e as Error).message };
            }
          }));
          const byWorker = new Map(results.map((r) => [r.worker.id, r]));
          // 本轮探测的完成时刻:整轮共用一个值(不是每行各自 now()),否则同一批行的
          // checkedAt 会差几毫秒,UI 上「N 秒前核对」会显示得参差不齐。
          const checkedAt = Date.now();
          const next = new Map<string, RecordingWorkerStatusDTO[]>();
          for (const rule of hubStore.listHubRules(rootHubDir())) {
            const sourceId = rule.recording?.sourceTaskId;
            if (sourceId == null) continue;
            const source = opts.store.getTask(sourceId);
            if (!source) continue;
            const platform = platformForRoom(source.room);
            const sync = resolveRuleSyncRoom(rule, source.room);
            const roomSlug = sync.roomSlug;
            warnRuleIdentityMismatch(rule, sync, opts.warn);
            const selectedIds = rule.workers?.length
              ? rule.workers
              : configuredWorkers.map((worker) => worker.id);
            const rows = selectedIds.flatMap((workerId) => {
              const result = byWorker.get(workerId);
              if (!result) return [];
              return [{
                workerId,
                workerName: result.worker.name ?? workerId,
                state: result.error
                  ? "unavailable" as const
                  : result.rooms.some((room) => room.platform === platform.id && room.roomSlug === roomSlug)
                    ? "recording" as const
                    : "not_recording" as const,
                checkedAt,
              }];
            });
            // 「房间是否要展示状态」与「当前是否已探到该房间」是独立维度：
            // 一条规则先探到、后被改成未探到（或源任务删除）时，若直接覆盖会留下陈旧状态。
            // 因此先清空该房间的旧条目,再写入本次结果。
            const key = recordingSnapshotKey(platform.id, roomSlug);
            next.set(key, rows);
          }
          // `next` 每次从空 Map 重建,天然丢掉「源任务已删除/解绑」的房间,
          // 不需要也不能在遍历 hubRecordingSnapshot 时删它(会边迭代边改)。
          setRecordingSnapshot(next);
          // F1:边录边传进度。节点探测失败 → 该节点的进度整体丢弃(不展示陈旧数字冒充实时)。
          setDeliverySnapshot(results.flatMap((r) => r.error ? [] : r.rolling.map((s): RollingDeliveryDTO => ({
            workerId: r.worker.id,
            workerName: r.worker.name ?? r.worker.id,
            platform: s.platform, roomSlug: s.roomSlug, anchorName: null,
            sessionBase: s.sessionBase, bv: s.bv ?? null,
            confirmed: s.confirmed, total: s.total, ambiguous: s.ambiguous,
            uploading: s.uploading ?? null, recording: s.recording, checkedAt,
            ...(s.lockedBytes !== undefined ? { lockedBytes: s.lockedBytes } : {}),
          }))));
        } catch (e) {
          opts.warn(`[hub] 刷新 worker 录制状态失败: ${(e as Error).message}`);
        } finally {
          refreshingRecordingStatus = false;
        }
      };
      const buildTransports = (): Map<string, ReturnType<typeof getTransport>> =>
        new Map(loadWorkers().map((w) => [w.id, getTransport(w)]));
      const transports = buildTransports();     // 初始 Map(pipelineDeps 也用它)
      const dbPath = (opts.dbPath ?? "douyin-rec.db").replace(/\.db$/, "-sync.db");
      const ledger = new SyncLedger(dbPath);
      // Zero-disk orchestration (issue #331): capability gate, receipt poll and console view live in
      // zero-disk-sync.ts; the starter only assembles the instance and hands its delivery book to the
      // spec builder.
      const zeroDisk = createZeroDiskSync({
        store: opts.store,
        log: opts.log,
        warn: opts.warn,
        onEvent: opts.onEvent,
        hubDir: () => hubDir,
        workers: loadWorkers,
        transports: buildTransports,
        dbPath,
      });

      // 投稿默认:uploadDefaults(新)> uploadMeta(旧,迁移兼容)> 硬兜底。
      const uploadDefaults = hubCfg.uploadDefaults ?? hubCfg.uploadMeta ?? {};
      // 磁盘水位(GB)统一口径(core resolveDiskMinGB):上传闸门 / reconciler 看门狗共用同一解析结果,非数字回落 10 并告警一次。
      const diskMinGB = resolveDiskMinGB(hubCfg.resources?.diskMinGB, (m) => console.warn(m)).gb;
      const defaultTag = uploadDefaults.tag ?? "直播,录像";
      const defaultTid = uploadDefaults.tid ?? 21;
      const defaultSeasonSectionId = normalizeSeasonSectionId(uploadDefaults.seasonSectionId);

      const { spawn } = await import("node:child_process");
      // T15:并行度/内存门槛**每轮热读**(UI 改完立即生效,无需重启)。
      // 读的是「当前真正生效的那份来源」(arg-file / settings / root-file 每次现解析),
      // 而不是构造时读一次的 hubCfg 快照 —— 否则 UI 改的是另一份文件,或改了要等重启。
      //
      // 上传限流三项**故意不给 live getter**:它们由 T8/T19 的持久化账本 + UploadGate 实时判定,
      // 热读配置反而会在改配置时**清掉已积累的窗口**,等于「每次改配置都重新放行一次」,
      // 正是 601 最怕的。构造值只作为冷启动基线。
      const liveResources = (): HubResources => {
        try {
          const resolved = resolveHubConfig(opts.hubConfigArg, opts.store);
          const cfg = resolved.json ? (JSON.parse(resolved.json) as { resources?: Partial<HubResources> }) : null;
          const r = cfg?.resources ?? {};
          return {
            maxCpuParallel: r.maxCpuParallel ?? hubCfg.resources?.maxCpuParallel ?? 1,
            maxNetParallel: r.maxNetParallel ?? hubCfg.resources?.maxNetParallel ?? 1,
            minBurnFreeMemMB: r.minBurnFreeMemMB ?? hubCfg.resources?.minBurnFreeMemMB ?? 1024,
            minMergeFreeMemMB: r.minMergeFreeMemMB ?? hubCfg.resources?.minMergeFreeMemMB ?? 512,
            maxConcurrentPipelines: r.maxConcurrentPipelines ?? hubCfg.resources?.maxConcurrentPipelines ?? 2,
          };
        } catch {
          // 配置在两次读取之间被改坏(JSON 解析失败)→ 沿用构造值,不能因为手滑就把闸门打不开。
          return {
            maxCpuParallel: hubCfg.resources?.maxCpuParallel ?? 1,
            maxNetParallel: hubCfg.resources?.maxNetParallel ?? 1,
            minBurnFreeMemMB: hubCfg.resources?.minBurnFreeMemMB ?? 1024,
            minMergeFreeMemMB: hubCfg.resources?.minMergeFreeMemMB ?? 512,
            maxConcurrentPipelines: hubCfg.resources?.maxConcurrentPipelines ?? 2,
          };
        }
      };
      const pool = new ResourcePool({
        maxCpuParallel: hubCfg.resources?.maxCpuParallel ?? 1,
        maxNetParallel: hubCfg.resources?.maxNetParallel ?? 1,
        minBurnFreeMemMB: hubCfg.resources?.minBurnFreeMemMB ?? 1024,
        maxCpuParallelLive: () => liveResources().maxCpuParallel ?? 1,
        maxNetParallelLive: () => liveResources().maxNetParallel ?? 1,
        minBurnFreeMemMBLive: () => liveResources().minBurnFreeMemMB ?? 1024,
        minMergeFreeMemMB: hubCfg.resources?.minMergeFreeMemMB ?? 512,
        minMergeFreeMemMBLive: () => liveResources().minMergeFreeMemMB ?? 512,
        memWaitTimeoutMs: hubCfg.resources?.memWaitTimeoutMs ?? 600_000,
        uploadRateLimit: hubCfg.resources?.uploadRateLimit ?? 5,
        uploadRateWindowMs: hubCfg.resources?.uploadRateWindowMs ?? 600_000,
        uploadCooldownMs: hubCfg.resources?.uploadCooldownMs ?? 1_800_000,
      }, {
        // T8:冷却/滑动窗口跨重启保留(同 sync 库 upload_limits 表)。
        // 复用 ledger 的 dbPath —— 两边同一文件,不额外造库;pool 只借用,不拥有生命周期。
        // T19:分键 = `bilibili:<DedeUserID>`(从本机 biliup cookies 解析)→ 节点侧上传用同一个键,
        // master 与节点的同账号冷却/窗口互相生效(键算法唯一真理 = core/upload-gate.ts)。
        limitStore: openUploadLimitStore(dbPath, { log: opts.warn }),
        limitKey: deps.masterUploadAccountKey(opts.warn),
        warn: opts.warn,
        onMemShortage: (message) => { opts.warn(message); opts.onEvent({ kind: "error", stage: "memory", message }); },
      });
      // plan 038: queue-managed upload settings; absent/invalid = safe defaults (blocking, nothing polled).
      const nodeUploadCfg = parseNodeUploadConfig((hubCfg as { nodeUpload?: unknown }).nodeUpload);
      const pipelineDeps = {
        transports,
        ledger,
        pool,
        nodeUpload: nodeUploadCfg,
        // 返回 stdout+stderr(各截尾 64KB,biliup 输出可达 MB 级)→ pipeline 摘尾写进该场 job.log。
        sh: (cmd: string) => new Promise<string>((res, rej) => {
          // detached 进程组:停任务时 kill(-pid) 能带走 ffmpeg 孙进程;其它 spawn 不建组。
          const p = spawn("sh", ["-c", cmd], { detached: true });
          registerChild(p, { processGroup: true });
          const tail = (s: string): string => (s.length > 65536 ? s.slice(-65536) : s);
          let stdout = "", stderr = "";
          p.stdout?.on("data", (b) => { stdout = tail(stdout + String(b)); });
          p.stderr?.on("data", (b) => { stderr = tail(stderr + String(b)); });
          p.on("error", rej);
          p.on("close", (code) => {
            try { throwIfAborted(); } catch (e) { rej(e); return; }
            if (code !== 0) rej(new Error(`sh rc=${code}\n${stderr}`));
            else res(`${stdout}\n${stderr}`);
          });
        }),
        // 穿插上传接缝:pipeline 先 fire 建稿(网络)与烧录并行,再 await BV 后串行 append。
        // 阶段 1b:建稿与 append 交给 UploadTarget(taget 内部仍是同一套 biliup 调用:
        // 逐线路重试 + parseBV + 分 P 数回读),并且把「结果不确定」表达成 proof 而不是靠错误文案。
        upload: createBiliupFileTarget(),
        // T11 核验接缝:取该稿件在 B站的**实际分 P 数**。核验的期望值来自上传时写下的
        // sync_parts 检查点(实际提交了几段),不用「文件大小上界」—— 那是评审明确否决的做法。
        // 缺省不注入 = 不做回读;这里注入 = 主控路径删最后一份源之前延后回读分 P 数,不一致则保留源并转人工(issue #327)。
        // cookies 用 hubCfg.cookies(与 appendGroup 同源;per-job override 已在 pipeline 内传下去)。
        countParts: (bv: string) => countVideoParts(bv, hubCfg.cookies ?? ""),
        // 延后回读总窗口(issues #92 / #327):首读约 2 分钟后,其后重读,至多 10 分钟;缺省 10 分钟。
        sideCheckDelayMs: hubCfg.sideCheckDelayMs,
        notify: opts.onEvent,
        // 收尾后留存转格式(plans/036 T9b):stage 源段副本派到本机处理任务表(master 数据根,与 `_enqueue` 同一执行体)。
        finalizeFormat: {
          stageProc: {
            enqueue: (req: EnqueueRequest) => handleEnqueue(drecRoot(), req),
            procStatus: (ids: string[]) => handleProcStatus(drecRoot(), ids),
          },
        },
        // Run logs are written by the composition root: observability FileLogger, path from core resolveJobLogPath
        // (same source of truth as hub-jobs). New sessions log under <root>/logs/hub, outside stage, so stage
        // cleanup can never swallow later log lines; a session whose legacy stage log exists keeps it (sticky).
        // The orchestrator only sees the ScopedLogger interface.
        // Master-local layout switch for NEW stage session dirs (issue #336); read per run, existing dirs are reused.
        stageLayout: () => readOutputLayout(),
        makeRunLogger: (streamKey: string) =>
          new FileLogger(resolveJobLogPath(hubCfg.stageDir ?? rootStageDir(), streamKey, { layout: "room", logsRoot: rootLogsDir() })),
        cfg: {
          cleanMaxGapSec: hubCfg.cleanMaxGapSec ?? 30,
          // 磁盘水位闸门(issue #8):与下面的 Reconciler 看门狗**同源同解析**(core resolveDiskMinGB)。
          diskMinGB,
          stageDir: hubCfg.stageDir ?? rootStageDir(),
          cookies: hubCfg.cookies ?? "",
          uploadMode: "stage" as const, // 全局兜底 = 不自动传;每任务文件按需 mode:"upload"
          uploadPrivate: true,
          uploadMeta: {
            tag: defaultTag, tid: defaultTid, desc: uploadDefaults.desc,
            titleTemplate: uploadDefaults.titleTemplate,
            submissionTitleTemplate: uploadDefaults.submissionTitleTemplate,
            partTitleTemplate: uploadDefaults.partTitleTemplate,
            ...(defaultSeasonSectionId ? { seasonSectionId: defaultSeasonSectionId } : {}),
          },
          timeZone: effectiveTimezone(opts.store),
        },
      };

      // 每房间 hub 任务配置来自文件 <root>/config/hub/{platform}.{roomSlug}.json(现读不缓存→手改/UI 即时生效)。
      // hub = 全局管理器:只处理「有 enabled 任务文件」的房间;无文件/禁用 → 返 null 跳过该房间。
      // 录制任务只管录;某房间产哪些、清不清理、传不传,全看它的 hub 任务文件。upload 留空回退全局默认。
      const hubDir = rootHubDir();
      const resolveCfg = (platform: string, slug: string): PipelineCfg | null => {
        const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(platform, slug));
        if (!rule || !rule.enabled) return null; // 无任务文件或已禁用 → hub 不处理该房间
        const p = rule.pipeline ?? {};
        const seasonSectionId = resolveSeasonSectionId(p.upload?.seasonSectionId, uploadDefaults.seasonSectionId);
        return {
          cleanMaxGapSec: hubCfg.cleanMaxGapSec ?? 30,
          // 磁盘水位闸门(issue #8):同上,与 reconciler 看门狗同一个配置键与默认值(不新增第二套口径)。
          diskMinGB,
          reconnectWindowMs: p.reconnectWindowMs ?? hubCfg.reconnectWindowMs,
          stageDir: hubCfg.stageDir ?? rootStageDir(),
          cookies: hubCfg.cookies ?? "",
          uploadMode: isUploadingMode(p.upload?.mode) ? "upload" : "stage", // upload/rolling → 传(rolling 只是上传时机提前,未建稿则整场管线兜底);其它值(含旧 stage-only)→ stage
          uploadPrivate: p.upload?.private !== false,                    // 缺省 / true → 仅自己可见
          uploadMeta: {
            tag: p.upload?.tag || defaultTag,
            tid: p.upload?.tid ?? defaultTid,
            desc: p.upload?.desc ?? uploadDefaults.desc,
            titleTemplate: (p.upload?.titleTemplate ?? "").trim() || uploadDefaults.titleTemplate,
            submissionTitleTemplate: (p.upload?.submissionTitleTemplate ?? "").trim() || uploadDefaults.submissionTitleTemplate,
            partTitleTemplate: (p.upload?.partTitleTemplate ?? "").trim() || uploadDefaults.partTitleTemplate,
            ...(seasonSectionId ? { seasonSectionId } : {}),
          },
          timeZone: effectiveTimezone(opts.store),
          steps: p.steps,
          cleanup: p.cleanup,
          uploadBatchSize: p.uploadBatchSize,
          minSegmentSec: p.minSegmentSec,
          // 分 P 目标时长 = 录制任务创建时的分段时长(segmentSec)。
          // 两者是同一个值:录制按它切段,上传就按它聚合成分 P。不单独在 hub 规则里配。
          // 规则里的 segmentGroupSec 若存在(历史遗留)仍作覆盖,便于个别房间微调。
          segmentGroupSec: p.segmentGroupSec
            ?? (rule.recording?.sourceTaskId
              ? opts.store.getTask(rule.recording.sourceTaskId)?.segmentSec
              : undefined),
          // 输出格式同理读源任务(issue #137);无源任务 → undefined = original(现状)。
          // 实际容器由 pipeline 经 core effectiveStageFormat 与 uploadMode 一并算出(投稿强制 mp4)。
          outputFormat: rule.recording?.sourceTaskId
            ? opts.store.getTask(rule.recording.sourceTaskId)?.outputFormat
            : undefined,
          // worker 硬过滤:reconciler 据此把 broadcast members 收窄到选中的 worker。
          // 缺省/空(老规则)→ reconciler 不过滤 = 全部 worker(向后兼容)。
          workers: rule.workers,
          // 能力门控:reconciler 据此把 members 再收窄到能力满足的 worker(与 workers 取交集)。
          requires: rule.requires,
        };
      };

      const reconciler = new Reconciler({
        platform: hubCfg.platform ?? "douyin",
        transports,
        ledger,
        pipelineDeps,
        resolveCfg,
        timeZone: () => effectiveTimezone(opts.store),
        // 能力门控:按 worker id 取能力标签(hub.config.json 的 workers[].capabilities)。
        workerCapabilities: (id) => loadWorkers().find((w) => w.id === id)?.capabilities,
        nodeUpload: nodeUploadCfg,
        reconnectWindowMs: hubCfg.reconnectWindowMs,
        blockedManualRounds: hubCfg.blockedManualRounds,
        loadTransports: buildTransports,
        notify: pipelineDeps.notify, // 达重试上限升级 needs_manual 时,复用 pipeline 同源 EventCenter 通知(站内+webhook)
        staleMs: hubCfg.resources?.staleMs ?? 600_000,
        // 磁盘看门狗:节点数据根剩余 < 阈值 → master 告警(worker 常没配 webhook,靠这边兜底)。缺省 10GB。
        diskMinGB,
        // T7:跨房间的调度并发(同时派发几场 pull/merge/burn/upload 流程)。
        // 不等于 CPU 并行度 —— merge/burn 仍由 maxCpuParallel 闸住(上面那一行,缺省 1)。
        // T15:热读当前生效的那份配置(T7 的 dispatcher 每轮取),UI 改完立即生效、无需重启。
        maxConcurrentPipelinesLive: () => liveResources().maxConcurrentPipelines ?? 2,
        ...(hubCfg.maxWaitSec != null || hubCfg.settleSec != null
          ? {
              settle: {
                maxWaitMs: (hubCfg.maxWaitSec ?? 600) * 1000,
                pollMs: (hubCfg.settleSec ?? 15) * 1000,
              },
            }
          : {}),
        observeInventory: (workerId, sessions) => {
          try {
            recordRoomSessions(rootStatsDbPath(), workerId, sessions);
          } catch (e) {
            console.warn(`[stats] ${workerId} 采集失败:${String((e as Error)?.message ?? e)}`);
          }
        },
      });

      // hub 受管录制任务同步:对每个 worker 计算「期望任务」并下发。
      // 规则里 recording.sourceTaskId 绑定的 master 任务 → 推送到规则 workers 勾选的节点;
      // 节点侧 applyRemoteTasks 按 (platform, roomSlug) 对账(收编/更新/两阶段删除)。
      // Issue #481: the room-list/spec builder lives in @drec/app so it can be driven by tests; this is only
      // the adapter that injects the master live state.
      const desiredFor = (workerId: string): RemoteTaskSpec[] => desiredSpecsForWorker(workerId, {
        rules: hubStore.listHubRules(hubDir),
        getTask: (id) => opts.store.getTask(id),
        workers: loadWorkers(),
        cookiesPath: hubCfg.cookies,
        allowsPush: zeroDisk.allowsPush,
        blockedKey,
        delivery: zeroDisk.delivery,
        warn: opts.warn,
        onRuleIdentityMismatch: (rule, sync) => warnRuleIdentityMismatch(rule, sync, opts.warn),
      });
      const syncTasks = createTaskSync({
        store: opts.store,
        manager: opts.manager,
        warn: opts.warn,
        log: opts.log,
        hubDir: () => hubDir,
        desiredFor,
        workers: loadWorkers,
        transports: buildTransports,
        cookieSync,
        beginRound: zeroDisk.beginRound,
        finishRound: zeroDisk.finishRound,
      });
      setSyncTasks(syncTasks);
      hubSyncGate.bind(syncTasks);

      // 正在进行的重跑(streamKey):检查与占用必须同步完成,否则并发请求会双双通过
      // isJobLive/hasStreamLock 检查、再被 withStreamLock 排队串行执行两次(上传类节点会重复投稿)。
      const retryingKeys = new Set<string>();
      // 手动单节点重跑:UI → web API → 这里。与 reconciler 共享同一 ResourcePool 流锁,保证同场不并发;
      // 上传类节点默认拒绝(可能已建稿/已 append),force 才放行(UI 二次确认)。
      const retryNode = async (
        streamKey: string,
        node: WorkflowNodeKey,
        force = false,
      ): Promise<{ ok: boolean; error?: string; code?: number }> => {
        const CORE: WorkflowNodeKey[] = ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"];
        const unsafe = (n: WorkflowNodeKey): boolean =>
          n === "upload_plain" || n === "append_danmu" || n === "append_livechat";
        if (!CORE.includes(node)) return { ok: false, error: `不可重跑的节点: ${node}`, code: 400 };
        if (unsafe(node) && !force) return { ok: false, error: `${node} 属上传类节点,需确认后才可重跑`, code: 400 };
        const parts = streamKey.split(":");
        if (parts.length < 3) return { ok: false, error: `非法 streamKey: ${streamKey}`, code: 400 };
        const platform = parts[0];
        const roomSlug = parts[1];
        const stageSub = stageSessionDir(hubCfg.stageDir ?? rootStageDir(), streamKey);
        const job = ledger.get(streamKey);
        // 同场 pipeline 正在跑(持流锁 / live job)→ 不排队,直接 409。
        // 否则会静默等在锁后,等当前上传完成又重跑一次,造成重复烧录/重复分 P。
        if (isJobLive(streamKey) || pool.hasStreamLock(streamKey)) {
          return { ok: false, error: "任务正在执行,不能重跑节点", code: 409 };
        }
        // 已建稿后重传 P1 会重复投稿;已有 append done 再跑 append 会重复分 P → 拒绝(除非 force 且 UI 二次确认)。
        if (node === "upload_plain" && job?.bv) {
          const appended = ["append_danmu", "append_livechat"].some(
            (k) => ledger.getNodeState(streamKey, k as WorkflowNodeKey)?.state === "done",
          );
          if (appended) return { ok: false, error: `已建稿(${job.bv})且已有分 P,不能重跑 P1(会重复投稿)`, code: 409 };
        }
        if (retryingKeys.has(streamKey)) {
          return { ok: false, error: "该场已有重跑在执行,请稍后", code: 409 };
        }
        retryingKeys.add(streamKey);
        return runWithJob(streamKey, async () => {
          try {
            return await pool.withStreamLock(streamKey, async () => {
              throwIfAborted();
              ledger.setState(streamKey, "retrying", {}, { force: true }); // 人工重跑:允许 done 场重跑单节点
              const cfg = resolveCfg(platform, roomSlug);
              if (!cfg) {
                ledger.setState(streamKey, "failed", { error: `房间未开 hub: ${streamKey}` });
                return { ok: false, error: `房间未开 hub: ${streamKey}`, code: 400 };
              }
              // 分段模式:产出/烧录/上传是一个整体(逐段 remux + 多文件建稿),不做单节点重跑
              // (单段重烧会与已建稿的分 P 错位)。用「重新运行」整场重跑(幂等:已建稿只补 append)。
              if (cfg.steps?.mergeSegments === false) {
                return { ok: false, error: "分段上传模式不支持单节点重跑,请用「重新运行」整场重跑", code: 400 };
              }
              ledger.backfillNodeStates(streamKey);
              const derived = deriveStageProducts(stageSub, effectiveStageFormat(cfg.outputFormat, cfg.uploadMode));
              if (!derived) {
                ledger.setState(streamKey, "failed", { error: `stage 产物缺失,无法重跑: ${stageSub}` });
                return { ok: false, error: `stage 产物缺失,无法重跑: ${stageSub}`, code: 409 };
              }
              const products = job?.outputStem ? withOutputStem(derived, job.outputStem) : derived;
              const workflow = buildWorkflow({
                streamKey, stageSub, products, deps: pipelineDeps, cfg, log: opts.log,
                willUpload: cfg.uploadMode === "upload",
                ...burnFlags(cfg.steps),
                segmentCount: 0,
              });
              const r = await runWorkflowNodes({
                streamKey, nodes: workflow.nodes, edges: workflow.edges, ctx: workflow.ctx,
                pool, forceRetry: new Set<WorkflowNodeKey>([node]),
              });
              if (r.ok) {
                if (cfg.uploadMode === "upload") {
                  const bv = ledger.get(streamKey)?.bv ?? "";
                  ledger.markDone(streamKey, bv);
                  if (bv) opts.onEvent({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}`, streamKey });
                } else {
                  // stage 模式正常收口必须带显式标记(issue #188):空 error 会被队列判成红灯事故。
                  closeStageReady(ledger, streamKey, cfg.uploadMode);
                }
                return { ok: true };
              }
              const errText = r.failed.length
                ? ledger.getNodeState(streamKey, r.failed[0])?.error ?? `节点失败: ${r.failed.join(",")}`
                : `节点被阻断: ${r.blocked.join(",")}`;
              if (errText === USER_STOP || r.blocked.some((k) => ledger.getNodeState(streamKey, k)?.error === USER_STOP)) {
                ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
                return { ok: false, error: USER_STOP, code: 409 };
              }
              ledger.setState(streamKey, "failed", { error: errText });
              return { ok: false, error: errText, code: 500 };
            });
          } catch (e) {
            if (isJobAbort(e)) {
              ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
              return { ok: false, error: USER_STOP, code: 409 };
            }
            throw e;
          }
        }).finally(() => retryingKeys.delete(streamKey));
      };
      setRetryNode((streamKey, node, o?: { force?: boolean }) =>
        retryNode(streamKey, node, o?.force === true));
      setStopJob((streamKey) => reconciler.stopJob(streamKey));
      setAckJob((streamKey, o) => reconciler.ackJob(streamKey, o));
      setRunNow((opts) => reconciler.runNow(opts));
      // 远端排空能力探测(issue #569):master 只查绑定的录制节点;本机(local)跳过(自己就支持)。
      // 任一节点旧 bundle / 不可达就失败 —— API 保持录制,绝不回退成硬停(硬停会截断当前分段)。
      setProbeDrainSupport(async (workerIds) => {
        for (const id of workerIds) {
          const w = loadWorkers().find((x) => x.id === id);
          if (!w) {
            // 老规则可能残留已删除的 worker id:desired 构造会忽略它(没有通道可下发),探测同样跳过,
            // 不能因此把整个房间的排空永久判失败(issue #569 review P2)。
            opts.warn(`[hub] 排空探测:规则的 worker ${id} 不在 hub 配置里,跳过`);
            continue;
          }
          if (w.kind === "local") continue;
          let t: ReturnType<typeof getTransport> | undefined;
          try {
            t = buildTransports().get(id);
          } catch (e) {
            return { ok: false, error: `节点 ${w.name ?? id} 通道配置无效: ${(e as Error).message}` };
          }
          if (!t) return { ok: false, error: `节点 ${w.name ?? id} 没有可用通道` };
          if (!t.nodeCapabilities) {
            return { ok: false, error: `节点 ${w.name ?? id} 不支持优雅排空(旧 bundle),请先升级节点` };
          }
          try {
            const caps = await t.nodeCapabilities();
            if (caps.drain !== true) {
              return { ok: false, error: `节点 ${w.name ?? id} 不支持优雅排空(旧 bundle),请先升级节点` };
            }
          } catch (e) {
            return { ok: false, error: `节点 ${w.name ?? id} 不可达,无法确认排空: ${(e as Error).message}` };
          }
        }
        return { ok: true };
      });
      // 队列页的「排队位次 / 资源占用」来源:读同一 ResourcePool 实例(进程内共享)。
      setPoolProviders({ poolSnapshot: () => pool.snapshot(), blockedBroadcasts: () => reconciler.blockedBroadcasts() });

      const stop = startHub({
        tasks: () => opts.store.listTasks(),
        isRecording: (id: number) => opts.manager.isRecording(id),
        reconcileAll: () => reconciler.reconcileAll(),
        pollUploadQueue: () => reconciler.pollUploadQueue(),
        uploadQueuePollMs: nodeUploadCfg.pollMs,
        settleMs: hubCfg.settleMs ?? 90_000,
        pollMs: hubCfg.pollMs ?? 3_000,
        reconcileIntervalMs: hubCfg.reconcileIntervalMs ?? 30 * 60_000,
        syncTasks,
        syncIntervalMs: hubCfg.syncIntervalMs ?? 60_000,
      });

      void refreshRecordingStatus();
      // T17:探测周期自适应 —— 有节点在录时 2s(用户最关心「录到没录到」的时刻),
      // 全空闲时 10s(没人录的时段不必频繁 SSH)。固定 5s 是两头都不讨好:
      // 开播瞬间那几秒仍显陈旧,而空闲时又在白跑 SSH。
      // 用**递归 setTimeout** 而非 setInterval:自适应周期在 setInterval 里做不到
      // (间隔在创建时就固定了),而且 setInterval 会在上一轮 SSH 还没回来时叠加下一轮。
      const RECORDING_BUSY_POLL_MS = 2_000;
      const RECORDING_IDLE_POLL_MS = 10_000;
      let recordingStatusTimer: ReturnType<typeof setTimeout> | null = null;
      // stop() 之后不许再排下一轮。
      // 自审发现:stop 只 clearTimeout 了**已排定**的那一次,但如果那一刻 refreshRecordingStatus()
      // 正在 SSH 途中,它的 .finally 会在 stop 之后**再排一轮** → hub 停了、探测还在跑,
      // 而且会一直跑下去(unref 只保证不挡进程退出,不代表逻辑停了)。这个泄漏没有任何症状,
      // 除非你恰好在 stop 的时候看了一眼 SSH 次数。
      let recordingProbeStopped = false;
      const scheduleRecordingStatusProbe = (delayMs: number): void => {
        if (recordingProbeStopped) return;
        recordingStatusTimer = setTimeout(() => {
          void refreshRecordingStatus().finally(() => {
            if (recordingProbeStopped) return;
            // 任何在录/不可达的节点 → 下一轮用快周期;全空闲 → 慢周期。
            // 用 finally:refreshRecordingStatus 内部已自己吞异常,这里只是保证
            // 「无论成功失败都继续排下一轮」——否则一次意外会让状态探测**永久停摆**
            // (自审发现:第一版把调度放在 then 里,失败路径直接断链,且没人会发现)。
            const busy = recordingSnapshotValues().some(
              (r) => r.state === "recording" || r.state === "unavailable",
            );
            scheduleRecordingStatusProbe(busy ? RECORDING_BUSY_POLL_MS : RECORDING_IDLE_POLL_MS);
          });
        }, delayMs);
        recordingStatusTimer.unref?.();
      };
      scheduleRecordingStatusProbe(RECORDING_IDLE_POLL_MS);
      opts.log(`[hub] 已启用，${loadWorkers().length} 个 worker`);
      return () => {
        stopFleet();
        stop();
        recordingProbeStopped = true;
        if (recordingStatusTimer) clearTimeout(recordingStatusTimer);
        setRecordingSnapshot(new Map());
        zeroDisk.clearSnapshot();
        setZeroDiskLive(undefined);
        setSyncTasks(undefined);
        hubSyncGate.unbind(); // 必须解绑:否则 stop 之后的同步请求会打到已停的旧 runner(自审发现)
        setRetryNode(undefined);
        setStopJob(undefined);
        setAckJob(undefined);
        setRunNow(undefined);
        setProbeDrainSupport(undefined);
        setPoolProviders({});
        setReceiptSettings(undefined);
      };
    },
    async testWorker(cfg) {
      // 注意:不能调 registerBuiltinTransports —— 那是全量 registry.set("local", …) 覆盖,
      // 若在 `task serve --hub` 运行期间调用会永久降级共享的 "local" transport 工厂
      // (isDone 退化恒 true → reconciler 不再等本地收播就合并残片;taskRooms 塌成 {} → 聚类失效)。
      // 探测只需一次性、不进 registry 的 scoped transport 实例,直接按 cfg.kind 构造。
      const { LocalTransport, SshTransport } = await import("@drec/orchestrator");
      const { ffprobeVideo } = await import("@drec/post-process");
      const { ensureNodeIdentity } = await import("@drec/app");
      const { statSync } = await import("node:fs");
      const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
        const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
        const endMs = statSync(file).mtimeMs;
        return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
      };
      const id = cfg.id ?? "test";
      const t = cfg.kind === "local"
        // 本机探测也带上身份(local 通常 id 固定 "local",但探测时也返回 nodeId 供 UI 展示一致性)。
        ? new LocalTransport({
            id, recordingsDir: `${cfg.dataRoot}/recordings`, taskRooms: {}, ffprobe,
            nodeIdentity: () => { const i = ensureNodeIdentity(cfg.dataRoot); return { nodeId: i.nodeId, hostname: i.hostname }; },
          })
        : new SshTransport({ id, host: cfg.host!, dataRoot: cfg.dataRoot!, fleet: fleetLink });
      try {
        // ping 内置超时(local 瞬时;ssh 6s)。这里不再额外包 20s——探针本就轻量。
        await t.ping!();
        // 顺带读节点稳定身份(local 无身份注入 → null;ssh 读 _node-id)。旧 bundle 无该命令 → 也返 null。
        // UI 用它作为 worker id,免去 master 自分配 worker-N(删了重建就换号的幽灵 id 问题)。
        const ident = await t.nodeId?.().catch(() => null) ?? null;
        return ident ? { ok: true, nodeId: ident.nodeId, hostname: ident.hostname } : { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async probeAllWorkers(): Promise<WorkerStatus[]> {
      // scoped 一次性 transport(不进全局 registry,不污染运行中的 hub);逐 worker ping,allSettled 汇总。
      const { LocalTransport, SshTransport } = await import("@drec/orchestrator");
      const { ffprobeVideo } = await import("@drec/post-process");
      const { statSync } = await import("node:fs");
      const { workerStore, rootHubConfig, withMasterReceipt } = await import("@drec/app");
      const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
        const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
        const endMs = statSync(file).mtimeMs;
        return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
      };
      const workers = workerStore.listWorkers(rootHubConfig());
      const results = await Promise.allSettled(workers.map(async (w) => {
        const t = w.kind === "local"
          ? new LocalTransport({
              id: w.id, recordingsDir: `${w.dataRoot}/recordings`, taskRooms: {}, ffprobe,
              // T16:本机也要能报版本,否则漂移告警漏掉 master 自己那台。
              nodeStatus: () => {
                let appliedVersion: number | null = null;
                let appliedAt: number | null = null;
                let appVersionAtApply: string | null = null;
                try {
                  const st = readManagedState(join(w.dataRoot ?? "", "config", "managed"));
                  appliedVersion = st?.version ?? null;
                  appliedAt = st?.savedAt ?? null;
                  appVersionAtApply = st?.appVersion ?? null;
                } catch { /* 未同步过 → null */ }
                return { appVersion: APP_VERSION, appliedVersion, appliedAt, appVersionAtApply, taskCount: 0, managedCount: 0 };
              },
            })
          : new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot!, fleet: fleetLink });
        await t.ping!();
        // 版本回执 / 磁盘剩余都是可选观测:拿不到(旧 bundle/不可达)就当没有 —— **绝不能因此让 status 失败**。
        // 两者并行,避免慢节点上串行叠加 ssh 超时。
        const [status, diskFreeGB] = await Promise.all([
          (async () => { try { return (await t.nodeStatus?.()) ?? null; } catch { return null; } })(),
          (async (): Promise<number | undefined> => {
            try {
              const g = await t.diskFreeGB?.();
              return typeof g === "number" && Number.isFinite(g) ? g : undefined;
            } catch { return undefined; }
          })(),
        ]);
        return { status, diskFreeGB };
      }));
      // 水位与磁盘看门狗同源(hub.config resources.diskMinGB);读不到/损坏 → 缺省口径,不抛。
      let rawMin: unknown;
      try { rawMin = (JSON.parse(readFileSync(rootHubConfig(), "utf-8")) as { resources?: { diskMinGB?: unknown } }).resources?.diskMinGB; } catch { rawMin = undefined; }
      const diskMinGB = resolveDiskMinGB(rawMin, (m) => console.warn(m)).gb;
      return workers.map((w, i) => {
        const r = results[i];
        if (r.status !== "fulfilled") {
          return { id: w.id, ok: false, error: (r.reason as Error)?.message ?? String(r.reason) };
        }
        const { status: ns, diskFreeGB } = r.value;
        const disk = diskFreeGB !== undefined ? { diskFreeGB, diskMinGB } : {};
        const base = ns
          ? { id: w.id, ok: true, appVersion: ns.appVersion, appliedVersion: ns.appliedVersion, appliedAt: ns.appliedAt, ...disk }
          : { id: w.id, ok: true, ...disk };
        // T16:把 master 侧期望版本与最近同步失败附在节点回执上;旧节点/未注入 → 字段缺省。
        const receiptSettings = getReceiptSettings();
        return receiptSettings ? withMasterReceipt(base, receiptSettings) : base;
      });
    },
  };
  // All-worker liveness/version/disk probe: 3 ssh calls per worker, and multiple browser tabs poll
  // independently — cache for 30s and merge concurrent calls so cost does not scale with tabs.
  hubStarter.probeAllWorkers = ttlMemoAsync(hubStarter.probeAllWorkers!.bind(hubStarter), PROBE_CACHE_MS);
  return hubStarter;
}
