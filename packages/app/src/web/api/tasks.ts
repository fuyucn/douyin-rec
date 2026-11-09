/**
 * web/api/tasks.ts — 任务 CRUD + 启停 + 平台列表
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildTasks(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { forbidsStreamUploadSpool, parseOutputFormat, platformForRoom, listPlatforms, STREAM_UPLOAD_NO_SPOOL_ERROR, streamUploadConflicts, zeroDiskRuleError, type OutputFormat } from "@drec/core";
import { inWindow, nowMinutesLocal } from "../../scheduler.js";
import type { CreateTaskInput, UpdateTaskInput, TaskView } from "./types.js";
import type { TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";
import { redactLogLines } from "@drec/core";
import * as hubStore from "../../hub-store.js";
import * as workerStore from "../../worker-store.js";
import { liveUploadPath, readLiveHistory, readLiveUploadFile } from "../../zero-disk-node.js";

/** Web 停止请求最多同步等待的时间(ms)。普通任务几秒内退出;rolling 任务可能在传末段,超时先返回。 */
const STOP_WAIT_MS = 15_000;

export function buildTasks(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, isHubSourceTask, resolveAnchorBg, view, detailView, normWebhook, toUseCookie } = ctx;
  return {
    listTasks(): ApiResult {
      return { status: 200, body: store.listTasks().map(view) };
    },

    createTask(input: CreateTaskInput): ApiResult {
      const room = (input.room ?? "").trim();
      if (!room) return err(400, "room 必填");
      if (input.streamUpload === true && forbidsStreamUploadSpool(input.streamUploadSpool)) {
        return err(400, STREAM_UPLOAD_NO_SPOOL_ERROR);
      }

      let scheduleStart = input.scheduleStart ?? null;
      let scheduleEnd = input.scheduleEnd ?? null;
      if (input.schedule && input.schedule.trim()) {
        try {
          [scheduleStart, scheduleEnd] = parseSchedule(input.schedule);
        } catch (e) {
          return err(400, (e as Error).message);
        }
      }

      let outputFormat: OutputFormat;
      try { outputFormat = parseOutputFormat(input.outputFormat); } catch (e) { return err(400, (e as Error).message); }
      // 0 落盘边录边传与滚动边录边传互斥(单一判定 = core.streamUploadConflicts)。
      // 手动建任务的 rollingEffective 由 store 从旧开关派生,故这里用同口径比较。
      if (streamUploadConflicts(input.streamUpload, input.rollingUpload === true)) {
        return err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件");
      }
      // A zero-disk task must be a rolling sub-mode. Validate the room rule up front so a
      // task created from the Tasks page cannot bypass the Rooms editor guard.
      const roomPlatform = platformForRoom(room);
      const roomSlug = roomPlatform.extractRoomSlug(room);
      const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(roomPlatform.id, roomSlug));
      const zerr = zeroDiskRuleError(input.streamUpload, rule
        ? { enabled: rule.enabled, mode: rule.pipeline?.upload?.mode, workers: rule.workers, steps: rule.pipeline?.steps }
        : null);
      if (zerr) return err(400, zerr);
      const task = store.addTask({
        room,
        name: input.name ?? null,
        quality: input.quality ?? "origin",
        engine: input.engine, // store 按 platform.engines 校验/回落
        danmu: toDanmuFlag(input.danmu),
        segmentSec: input.segmentSec ?? 1800,
        cookies: input.cookies ?? null,
        useCookie: toUseCookie(input.useCookie),
        outDir: input.outDir ?? null,
        scheduleStart,
        scheduleEnd,
        webhook: normWebhook(input.webhook),
        rollingUpload: input.rollingUpload === true,
        streamUpload: input.streamUpload === true,
        streamUploadSpool: true,
        outputFormat,
      });
      // 创建即抓主播名（不等开始录制）；后台写回，UI 轮询即显示。
      resolveAnchorBg(task.id, task.room);
      return { status: 201, body: view(task) };
    },

    updateTask(id: number, input: UpdateTaskInput): ApiResult {
      const existing = store.getTask(id);
      if (!existing) return err(404, `未找到任务 id=${id}`);
      if (existing.managedBy === "hub") {
        return err(403, `任务 id=${id} 由 hub 管理，请在 master 上修改`);
      }
      const nextStreamUpload = "streamUpload" in input ? input.streamUpload === true : existing.streamUpload;
      if (nextStreamUpload && forbidsStreamUploadSpool(input.streamUploadSpool)) {
        return err(400, STREAM_UPLOAD_NO_SPOOL_ERROR);
      }

      // Build a patch with ONLY the keys the client actually sent, so omitted
      // fields stay untouched (store.updateTask keys off `in patch`).
      const patch: Parameters<TaskStore["updateTask"]>[1] = {};

      if ("room" in input) {
        const room = (input.room ?? "").trim();
        if (!room) return err(400, "room 不能为空");
        patch.room = room;
      }
      if ("name" in input) patch.name = input.name ?? null;
      if ("quality" in input) patch.quality = input.quality;
      if ("engine" in input) patch.engine = input.engine; // store 按 platform 校验
      if ("danmu" in input) patch.danmu = toDanmuFlag(input.danmu);
      if ("useCookie" in input) patch.useCookie = toUseCookie(input.useCookie);
      if ("segmentSec" in input) patch.segmentSec = input.segmentSec;
      if ("cookies" in input) patch.cookies = input.cookies ?? null;
      if ("outDir" in input) patch.outDir = input.outDir ?? null;
      if ("webhook" in input) patch.webhook = normWebhook(input.webhook);
      if ("rollingUpload" in input) patch.rollingUpload = input.rollingUpload === true;
      if ("streamUpload" in input) patch.streamUpload = input.streamUpload === true;
      if ("streamUploadSpool" in input) patch.streamUploadSpool = true;
      // 互斥校验用**patch 后的生效值**(只改了其中一边时也要挡住另一边的存量值)。
      if (streamUploadConflicts(patch.streamUpload ?? existing.streamUpload, patch.rollingUpload ?? existing.rollingUpload)) {
        return err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件");
      }
      // Zero-disk must be valid for the room the task will actually live in after this patch,
      // not just the room it had before. A plain room change can otherwise walk a live task
      // into a non-rolling/burning/multi-node rule while `--stream-upload` stays on.
      if ((patch.streamUpload ?? existing.streamUpload) === true) {
        const room = (patch.room ?? existing.room);
        const p = platformForRoom(room);
        const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(p.id, p.extractRoomSlug(room)));
        const zerr = zeroDiskRuleError(true, rule
          ? { enabled: rule.enabled, mode: rule.pipeline?.upload?.mode, workers: rule.workers, steps: rule.pipeline?.steps }
          : null);
        if (zerr) return err(400, zerr);
      }
      // A task that is already the source of a rolling rule may switch to zero-disk:
      // zero-disk is that rule's sub-mode and reports its own ledger result. The zero-disk
      // rule check above rejects any non-rolling / burning / multi-node rule.
      if ("outputFormat" in input) {
        try { patch.outputFormat = parseOutputFormat(input.outputFormat); } catch (e) { return err(400, (e as Error).message); }
      }

      // schedule "HH:MM-HH:MM" wins over explicit scheduleStart/End if present.
      if (input.schedule !== undefined) {
        if (input.schedule && input.schedule.trim()) {
          try {
            const [s, e] = parseSchedule(input.schedule);
            patch.scheduleStart = s;
            patch.scheduleEnd = e;
          } catch (e) {
            return err(400, (e as Error).message);
          }
        } else {
          // empty schedule string → clear both
          patch.scheduleStart = null;
          patch.scheduleEnd = null;
        }
      } else {
        if ("scheduleStart" in input) patch.scheduleStart = input.scheduleStart ?? null;
        if ("scheduleEnd" in input) patch.scheduleEnd = input.scheduleEnd ?? null;
      }

      const updated = store.updateTask(id, patch);
      if (!updated) return err(404, `未找到任务 id=${id}`);
      // **房间号真的变了** → 主播可能不同了，重新抓。
      // 注意必须比对旧值：前端编辑时总会带上 room 字段(即使没改)，只看 `"room" in patch`
      // 会导致「只改弹幕开关也把主播名清空」。
      // **不要先清空再抓**(T-4)：抓取可能失败(如房间 HTML 被风控拦 / 新房间暂不可达)，
      // 先清会让 anchorName 永久变 null、界面主播信息凭空消失。改为「抓到才替换」——
      // 抓失败就保留旧名(略陈旧好过空白)。
      if (patch.room && patch.room !== existing.room) {
        resolveAnchorBg(id, patch.room);
      }
      // 该任务是 hub 源任务 → 改动(如 danmu/quality/segmentSec/useCookie/outDir…)立即同步到节点。
      // 漏了这句会导致「改了主节点任务但远端仍是旧值」，直到下次 start/stop 才纠正。
      if (isHubSourceTask(id)) deps.requestSyncTasks?.();
      return { status: 200, body: view(updated) };
    },

    getTask(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      return { status: 200, body: detailView(t) };
    },

    getTaskLogs(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      // 出网前脱敏:日志里可能带 cookie(vendored 取流代码在异常信息里打印整串)。
      // 这里覆盖「节点自己的网页」与「master 代查(F3)」两条出口。
      return { status: 200, body: { lines: redactLogLines(manager.getLogs(id)) } };
    },

    getTaskLive(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      if (!t.streamUpload) return err(404, "任务未开启直播直传");
      const p = platformForRoom(t.room);
      const roomSlug = p.extractRoomSlug(t.room);
      const entries: Array<{ workerId: string; workerName: string; current?: unknown; previous?: unknown; history?: unknown }> = [];
      if (t.managedBy !== "hub") {
        const local = readLiveUploadFile(liveUploadPath(p.id, roomSlug));
        const history = readLiveHistory(p.id, roomSlug);
        if (local || history.length) entries.push({ workerId: "local", workerName: "本机", ...local, ...(history.length ? { history } : {}) });
      }
      entries.push(...(deps.zeroDiskLive?.(p.id, roomSlug) ?? []));
      return { status: 200, body: { entries } };
    },

    async deleteTask(id: number): Promise<ApiResult> {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      if (t.managedBy === "hub") {
        return err(403, `任务 id=${id} 由 hub 管理，请在 master 上删除`);
      }
      if (t.enabled || manager.isRunning(id)) {
        return err(409, `任务 id=${id} 仍启用或运行中，请先停止再删除`);
      }
      store.removeTask(id);
      return { status: 200, body: { ok: true, id } };
    },

    refreshTaskAnchor(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      if (!t.anchorName) resolveAnchorBg(id, t.room, { throttleMs: 5 * 60_000 });
      return { status: 200, body: { ok: true } };
    },

    startTask(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      if (t.managedBy === "hub") return err(403, `任务 id=${id} 由 hub 管理，请在 master 上操作`);
      // 磁盘水位准入(issue #96):手动启动此前绕过闸门。**只在这次点击会真的起录制进程时**才检查
      // (已在跑 / 不在窗口内 / 被 hub 抑制时点「启动 / 启用」不会起进程,不该因低水位被拒)。
      // 低于水位 → 明确报错且**不改任务状态**(不置 enabled),避免「已启用却不会录」的假象;测任务自己的输出目录。
      const wouldStart = !manager.isRunning(id)
        && !deps.localSuppressedIds?.()?.has(id)
        && inWindow(nowMinutesLocal(new Date()), t.scheduleStart, t.scheduleEnd);
      const admit = wouldStart ? deps.admitStart?.(t.outDir) : undefined;
      if (admit && !admit.ok) return err(409, `磁盘空间不足,未启动任务 id=${id}:${admit.reason}`);
      // 启动 = 一轮新的明确意图,清掉上一次的排空标记(issue #569);与 enabled 写在同一条 UPDATE。
      const prevDrain = t.drainRequested;
      try {
        store.updateTask(id, { enabled: true, drainRequested: false });
        // hub 语义:该任务是某条规则的源任务、且规则已把录制切给远端节点(workers 不含 local)
        // → 本机**不要**实跑(源任务在此只作配置模板)。否则「启动」会绕过 daemon 的抑制名单,
        // 造成本机与远端同场重复录制(实测踩到:本地 recording=true 而规则 workers=[vps2])。
        const suppressed = deps.localSuppressedIds?.();
        if (!suppressed?.has(id)) {
          const eligible = inWindow(nowMinutesLocal(new Date()), t.scheduleStart, t.scheduleEnd);
          if (eligible && !manager.isRunning(id)) manager.start(id);
        }
      } catch (e) {
        // 启动失败要把 enabled 回滚，避免下一轮周期同步把失败状态传到节点。
        // 若原先正在排空,连排空意图一起恢复:失败不该把「录完这场再停」降级成硬停。
        try { store.updateTask(id, { enabled: false, drainRequested: prevDrain }); } catch { /* 回滚失败以原始错误为准 */ }
        return err(500, `启动任务失败: ${(e as Error).message}`);
      }
      if (isHubSourceTask(id)) deps.requestSyncTasks?.();
      return { status: 200, body: view(store.getTask(id)!) };
    },

    /**
     * POST /api/tasks/:id/drain —— **优雅排空**:停止寻找新开播,让当前这场录到自然收播。
     *
     * 与 stopTask 的区别是本任务存在的原因:硬停会**截断当前录像**(子进程被杀,分段不完整),
     * 而广播通常还在进行。窗口结束/临时停用时想要的是「不再接新场,但别腰斩现在这场」。
     *
     * 两条执行路径(issue #569):
     * - 本机录制器在跑 → 置停用 + stopGraceful(原有行为);
     * - hub 房间只由远端节点录制(master 的源任务只是配置模板,本机没有进程)→ 写排空意图,
     *   由下一轮任务同步把 `enabled=false + drain=true` 下发到节点;节点 apply-tasks 立即走
     *   `/drain`(SIGUSR2),daemon 的 stopGraceful 兜底。**置停用之前**只探测「可能正在录」的
     *   目标节点(状态 recording / unavailable / 快照缺失)是否理解 drain:不支持/不可达就拒绝并
     *   保持录制,绝不回退成硬停;空闲节点不探测(它的停用本来就是空操作,混部升级不挡本机排空)。
     */
    async drainTask(id: number, opts: { internal?: boolean } = {}): Promise<ApiResult> {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      // 内部排空仅限本机回环调用(节点 apply-tasks 的 drain 通道),与 stopTask 的 internal 同口径。
      if (t.managedBy === "hub" && !opts.internal) {
        return err(403, `任务 id=${id} 由 hub 管理,请在 master 上操作`);
      }

      const localRunning = manager.isRunning(id);
      // 绑定了该源任务的 hub 规则选中的远端节点(不含 local)。源任务在本机可能只是配置模板。
      // 旧配置的 `workers` 缺省/空 = 全选(core `isWorkerTargeted` 语义),这里展开成当前 worker 列表,
      // 否则老规则房间的排空按钮亮着却必 409(issue #569 review P1)。
      // internal = 节点侧自己的动作,不再向下递归找节点(节点没有 hub 规则;也不该依赖 master 能力探测)。
      const configuredWorkers = workerStore.listWorkers(hubConfigPath).map((w) => w.id);
      const remoteTargets = opts.internal ? [] : [...new Set(
        hubStore.listHubRules(hubDir)
          .filter((r) => r.recording?.sourceTaskId === id)
          .flatMap((r) => (r.workers && r.workers.length > 0 ? r.workers : configuredWorkers)),
      )].filter((w) => w !== "local" && configuredWorkers.includes(w));

      if (!opts.internal && !localRunning && remoteTargets.length === 0) {
        // 没在跑就没什么可排空的:说清楚,别给一个「成功」让人以为改了状态。
        return err(409, "该任务当前没有在录制,无需排空");
      }

      if (remoteTargets.length > 0) {
        // 远端是否真的在录:只看绑定的节点(房间状态用的也是这份快照,与按钮可见性同源)。
        const platform = platformForRoom(t.room);
        const roomSlug = platform.extractRoomSlug(t.room);
        const states = deps.recordingWorkers?.(platform.id, roomSlug) ?? [];
        const stateOf = (w: string) => states.find((s) => s.workerId === w)?.state;
        const recording = remoteTargets.filter((w) => stateOf(w) === "recording");
        const unknown = remoteTargets.filter((w) => stateOf(w) === "unavailable" || stateOf(w) === undefined);
        if (!localRunning && recording.length === 0) {
          // 「不知道」不能写成「没在录」:快照为空/节点离线时用户看到的必须是可重试的原因。
          return unknown.length > 0
            ? err(409, "无法确认节点是否在录制,未排空(请稍后重试)")
            : err(409, "该任务当前没有在录制,无需排空");
        }
        // 置停用之前确认「可能正在录」的目标节点都理解 drain:旧节点会忽略该字段、把停用当硬停。
        // 空闲节点不探测 —— 它收到 enabled=false 的硬停本来就是空操作;混部 master 先上线、
        // worker 未升级时,本机单录的房间仍能排空(旧行为不回归,issue #569 review P1)。
        const mustProbe = remoteTargets.filter((w) => stateOf(w) === "recording" || stateOf(w) === "unavailable" || stateOf(w) === undefined);
        if (mustProbe.length > 0) {
          if (!deps.probeDrainSupport) {
            return err(409, "hub 未启用,无法向录制节点下发排空");
          }
          const support = await deps.probeDrainSupport(mustProbe);
          if (!support.ok) {
            return err(409, `无法安全排空:${support.error ?? "节点不支持优雅排空"}`);
          }
        }
      }

      // 意图先落库:即使本机 stopGraceful 失败,daemon 下一轮也会按「停用」让当前场录到自然收播。
      try {
        store.updateTask(id, { enabled: false, drainRequested: true });
      } catch (e) {
        return err(500, `排空失败: ${(e as Error).message}`);
      }
      if (localRunning) {
        // 与原来的 stopGraceful 一致;失败不回滚意图 —— 回滚会让远端节点重新接新场,
        // 而这里已经承诺「录完这场再停」。
        await manager.stopGraceful(id).catch(() => {});
      }
      if (isHubSourceTask(id)) deps.requestSyncTasks?.();
      return { status: 200, body: view(store.getTask(id)!) };
    },

    async stopTask(id: number, opts: { internal?: boolean } = {}): Promise<ApiResult> {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      // 内部停止仅限本机回环调用(_apply-tasks 的硬停通道),供 hub 停用/删除受管任务;
      // 外部 UI/API 仍禁止直接操作受管任务,必须回 master 改源任务。
      if (t.managedBy === "hub" && !opts.internal) {
        return err(403, `任务 id=${id} 由 hub 管理，请在 master 上操作`);
      }
      // 硬停 = 用户明确要立即停,同样清掉排空意图(否则下一轮同步还会带 drain、阻止硬停)。
      const prevDrain = t.drainRequested;
      try {
        store.updateTask(id, { enabled: false, drainRequested: false });
        // 最多等 STOP_WAIT_MS:普通任务几秒内退出;rolling 任务要给末段上传留时间,超时就先返回(仍在停止中)。
        if (manager.isRunning(id)) await manager.stopWithin(id, STOP_WAIT_MS);
      } catch (e) {
        try { store.updateTask(id, { enabled: true, drainRequested: prevDrain }); } catch { /* 回滚失败以原始错误为准 */ }
        return err(500, `停止任务失败: ${(e as Error).message}`);
      }
      if (isHubSourceTask(id)) deps.requestSyncTasks?.();
      return { status: 200, body: view(store.getTask(id)!) };
    },

    listPlatforms(): ApiResult {
      // 平台配置投影(可序列化)。registerPlatform 顺序 = 第一个为默认(douyin),前端无命中时回落它。
      const platforms = listPlatforms().map((p) => ({
        id: p.id,
        urlPattern: p.urlPattern ?? null,
        qualities: p.qualities,
        engines: p.engines,
        defaultQuality: p.defaultQuality,
        defaultEngine: p.defaultEngine,
        // 平台是否有弹幕能力(connectDanmu 非空);前端据此显示/禁用弹幕开关。
        hasDanmu: typeof p.connectDanmu === "function",
      }));
      return { status: 200, body: { platforms } };
    },
  };
}
