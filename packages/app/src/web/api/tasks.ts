/**
 * web/api/tasks.ts — 任务 CRUD + 启停 + 平台列表
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildTasks(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { platformForRoom, listPlatforms } from "@drec/core";
import { inWindow, nowMinutesLocal } from "../../scheduler.js";
import type { CreateTaskInput, UpdateTaskInput, TaskView } from "./types.js";
import type { TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";

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

      let scheduleStart = input.scheduleStart ?? null;
      let scheduleEnd = input.scheduleEnd ?? null;
      if (input.schedule && input.schedule.trim()) {
        try {
          [scheduleStart, scheduleEnd] = parseSchedule(input.schedule);
        } catch (e) {
          return err(400, (e as Error).message);
        }
      }

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
      return { status: 200, body: { lines: manager.getLogs(id) } };
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
      try {
        store.setEnabled(id, true);
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
        try { store.setEnabled(id, false); } catch { /* 回滚失败以原始错误为准 */ }
        return err(500, `启动任务失败: ${(e as Error).message}`);
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
      try {
        store.setEnabled(id, false);
        if (manager.isRunning(id)) await manager.stop(id);
      } catch (e) {
        try { store.setEnabled(id, true); } catch { /* 回滚失败以原始错误为准 */ }
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
