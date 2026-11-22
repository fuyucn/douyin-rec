/**
 * web/api/hub-jobs.ts — hub 运行台账:job 列表 / 日志 / 队列 / 重跑 / 停止
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildHubJobs(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { HUB_JOB_STATES, QUEUE_PHASES, isUploadingMode, platformForRoom, classifySqliteError, sqliteErrorText, SQLITE_IO_HINT, type HubJobsDTO, type QueuePhase } from "@drec/core";
import { listHubJobs, readHubJobLog, latestRunPerRoom, buildQueueView } from "../../hub-jobs.js";
import { HubJobLedgerSchemaError } from "../../hub-job-ledger.js";
import * as hubStore from "../../hub-store.js";
import { knownTaskName } from "../../hub-label-lookup.js";

/**
 * 台账读失败 → (HTTP 状态, 文案)。I/O 类（issue #742）回 503 并点明挂载/Restart 提示；
 * 其余（锁/损坏/未知）沿用 500，文案保持原样。
 */
function ledgerFailure(error: unknown): { status: number; message: string } {
  if (error instanceof HubJobLedgerSchemaError) return { status: 500, message: `读 hub 台账失败: ${error.message}` };
  const failure = classifySqliteError(error);
  const rawText = sqliteErrorText(error) || String((error as Error)?.message ?? error);
  if (failure === "io") return { status: 503, message: `读 hub 台账失败 (数据库 I/O 错误): ${SQLITE_IO_HINT}（原文：${rawText}）` };
  const reason = failure === "locked" ? "数据库被锁定" : failure === "corrupt" ? "数据库损坏" : "数据库查询失败";
  const code = (error as { code?: unknown })?.code;
  const codeText = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "DB_ERROR";
  return { status: 500, message: `读 hub 台账失败 (${codeText}): ${reason}；请检查文件状态、锁与存储 I/O（原文：${rawText}）` };
}

export function buildHubJobs(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, hubRuleView } = ctx;
  return {
    listHubJobs(opts: { room?: string; limit?: number; offset?: number; states?: string[] } = {}): ApiResult {
      if (!deps.syncDbPath) return { status: 200, body: { jobs: [], total: 0 } }; // slave/hub 未开 → 空
      // states 走契约白名单(防任意串;非法值丢弃 → 不过滤)。
      const states = (opts.states ?? [])
        .flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean)
        .filter((st) => (HUB_JOB_STATES as readonly string[]).includes(st));
      try {
        const { jobs, total } = listHubJobs(deps.syncDbPath, {
          room: opts.room,
          limit: opts.limit ?? 20,
          offset: opts.offset ?? 0,
          states: states.length > 0 ? states : undefined,
        });
        const response = { jobs, total } satisfies HubJobsDTO;
        return { status: 200, body: response };
      } catch (e) {
        const failure = ledgerFailure(e);
        return err(failure.status, failure.message);
      }
    },

    getHubJobLog(streamKey: string): ApiResult {
      const log = readHubJobLog(streamKey);
      if (log == null) return err(404, `该场无 job.log(旧版本产生的任务没有,或 stage 已清理): ${streamKey}`);
      return { status: 200, body: { streamKey, log } };
    },

    latestRuns(): ApiResult {
      if (!deps.syncDbPath) return { status: 200, body: { rooms: [] } };
      try {
        return { status: 200, body: { rooms: latestRunPerRoom(deps.syncDbPath) } };
      } catch (e) {
        const failure = ledgerFailure(e);
        return err(failure.status, failure.message);
      }
    },

    hubQueue(opts: { phase?: string[]; states?: string[]; platform?: string[]; q?: string; sort?: "newest" | "oldest" } = {}): ApiResult {
      if (!deps.syncDbPath) {
        // slave/hub 未开 → 空队列(+ 空资源池),前端显示空态。
        return {
          status: 200,
          body: {
            active: [], recent: [],
            pool: { cpu: { active: 0, queued: 0, max: 0 }, net: { active: 0, queued: 0, max: 0 },
              upload: { active: 0, queued: 0, cooldownUntil: 0, windowUsed: 0, windowLimit: 0, windowResetAt: 0 }, waiting: [] },
          },
        };
      }
      try {
        // 一次 listTasks 建 roomSlug+platform → 显示名映射;名称走与通知相同的 core 链路(#53)。
        const tasks = store.listTasks();
        const anchorOf = (platform: string, roomSlug: string): string | null => {
          const t = tasks.find(
            (task) => platformForRoom(task.room).id === platform
              && platformForRoom(task.room).extractRoomSlug(task.room) === roomSlug,
          );
          return t ? knownTaskName(t, manager.getAnchorName(t.id)) : null;
        };
        // query 过滤白名单校验:只认契约里的常量(防任意串进 Set;也防前端拼错静默返回空)。
        const csv = (v?: string[]): string[] =>
          (v ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
        const phaseFilter = csv(opts.phase).filter((p): p is QueuePhase =>
          (QUEUE_PHASES as readonly string[]).includes(p));
        const stateFilter = csv(opts.states).filter((s) => (HUB_JOB_STATES as readonly string[]).includes(s));

        // 该房间规则禁用的节点 → 从 nextSteps 剔除(upload 类只在 upload 模式;burn_* 按 steps 开关)。
        const disabledOf = (platform: string, roomSlug: string): ReadonlySet<string> | null => {
          const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(platform, roomSlug));
          if (!rule) return null; // 无规则:未知 → 不剔除(nodeStates 的 skipped 会自纠)
          const p = rule.pipeline ?? {};
          const out = new Set<string>();
          if (p.steps?.burnDanmu === false) out.add("burn_danmu");
          if (p.steps?.burnLivechat === false) out.add("burn_livechat");
          if (!isUploadingMode(p.upload?.mode)) {
            out.add("upload_plain").add("append_danmu").add("append_livechat");
          }
          return out;
        };
        const view = buildQueueView(deps.syncDbPath, {
          anchorOf, disabledOf, pool: deps.poolSnapshot?.(),
          phase: phaseFilter, states: stateFilter, platform: opts.platform, q: opts.q,
          // sort 白名单:只认 newest / oldest,其它回落 newest(不静默改变语义)。
          sort: opts.sort === "oldest" ? "oldest" : "newest",
        });
        // 边录边传实时进度(F1):节点状态轮询的快照,补主播名;不受 phase/states 筛选影响,平台与关键字筛选照常生效。
        const q = (opts.q ?? "").trim().toLowerCase();
        const plats = csv(opts.platform);
        const delivering = (deps.rollingDelivery?.() ?? [])
          .map((d) => ({ ...d, anchorName: anchorOf(d.platform, d.roomSlug) }))
          .filter((d) => plats.length === 0 || plats.includes(d.platform))
          .filter((d) => !q || `${d.anchorName ?? ""} ${d.roomSlug} ${d.sessionBase} ${d.bv ?? ""}`.toLowerCase().includes(q));
        const blocked = (deps.blockedBroadcasts?.() ?? [])
          .map((b) => ({ ...b, anchorName: anchorOf(b.platform, b.roomSlug) }))
          .filter((b) => plats.length === 0 || plats.includes(b.platform))
          .filter((b) => !q || `${b.anchorName ?? ""} ${b.roomSlug} ${b.streamKey} ${b.workers.join(" ")}`.toLowerCase().includes(q));
        return { status: 200, body: { ...view, delivering, blocked } };
      } catch (e) {
        const failure = classifySqliteError(e);
        const rawText = sqliteErrorText(e) || String((e as Error)?.message ?? e);
        return failure === "io"
          ? err(503, `读 hub 队列失败 (数据库 I/O 错误): ${SQLITE_IO_HINT}（原文：${rawText}）`)
          : err(500, `读 hub 队列失败: ${rawText}`);
      }
    },

    async retryHubNode(streamKey: string, input: { node?: string; force?: boolean }): Promise<ApiResult> {
      if (!deps.syncDbPath || !deps.retryNode) return err(400, "hub 未启用(单节点重跑未注入)");
      if (!input.node) return err(400, "node 必填");
      const r = await deps.retryNode(streamKey, input.node, { force: input.force === true });
      return r.ok ? { status: 200, body: r } : { status: r.code ?? 400, body: r };
    },

    async stopHubJob(streamKey: string): Promise<ApiResult> {
      if (!deps.syncDbPath || !deps.stopJob) return err(400, "hub 未启用(停止任务未注入)");
      const r = await deps.stopJob(streamKey);
      return r.ok ? { status: 200, body: r } : { status: r.code ?? 400, body: r };
    },

    async ackHubJob(streamKey: string, input: { note?: string; undo?: boolean }): Promise<ApiResult> {
      if (!deps.syncDbPath || !deps.ackJob) return err(400, "hub 未启用(核对标记未注入)");
      const note = typeof input.note === "string" ? input.note : undefined;
      const r = await deps.ackJob(streamKey, { note, undo: input.undo === true });
      return r.ok ? { status: 200, body: r } : { status: r.code ?? 400, body: r };
    },

    async runHubJob(input: { streamKey?: string; winnerWorker?: string; wait?: boolean; force?: boolean }): Promise<ApiResult> {
      if (!deps.syncDbPath || !deps.runNow) return err(400, "hub 未启用(立即执行未注入)");
      if (!input.streamKey) return err(400, "streamKey 必填");
      const r = await deps.runNow({
        streamKey: input.streamKey,
        winnerWorker: input.winnerWorker,
        wait: input.wait === true,
        force: input.force === true,
      });
      return r.ok ? { status: r.code ?? 202, body: r } : { status: r.code ?? 400, body: r };
    },
  };
}
