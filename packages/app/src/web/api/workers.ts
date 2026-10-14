/**
 * web/api/workers.ts — 录制 worker CRUD + 连接测试 + 存活探测
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildWorkers(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import * as workerStore from "../../worker-store.js";
import * as hubStore from "../../hub-store.js";
import type { WorkerTestResult, WorkerStatus, WorkerDTO } from "@drec/core";

export function buildWorkers(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, workerToDto } = ctx;
  return {
    listWorkers(): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      return { status: 200, body: workerStore.listWorkers(hubConfigPath).map(workerToDto) };
    },

    createWorker(input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[]; id?: string }): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      try {
        const w = workerStore.createWorker(hubConfigPath, {
          name: input.name ?? undefined, kind: input.kind ?? "", host: input.host, dataRoot: input.dataRoot, apiUrl: input.apiUrl,
          capabilities: input.capabilities,
          // 显式 id:UI「测试连接」探测到的节点稳定身份(nodeId),用它替代自分配 worker-N。
          id: input.id,
        });
        deps.requestSyncTasks?.();
        return { status: 201, body: workerToDto(w) };
      } catch (e) { return err(400, (e as Error).message); }
    },

    updateWorker(id: string, input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[] }): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      try {
        const w = workerStore.updateWorker(hubConfigPath, id, input);
        if (!w) return err(404, `未找到 worker id=${id}`);
        deps.requestSyncTasks?.();
        return { status: 200, body: workerToDto(w) };
      } catch (e) { return err(400, (e as Error).message); }
    },

    deleteWorker(id: string): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      // 被 hub 规则引用的 worker 不能删:删除后规则里留下幽灵 id,本机被抑制、远端又收不到任务 → 静默漏录。
      const refs = hubStore.listHubRules(hubDir).filter((r) => (r.workers ?? []).includes(id));
      if (refs.length > 0) {
        return err(409, `worker ${id} 仍被 ${refs.length} 条 hub 规则引用(${refs.slice(0, 3).map((r) => r.key).join(", ")}${refs.length > 3 ? " …" : ""}),请先改规则再删`);
      }
      try {
        const ok = workerStore.deleteWorker(hubConfigPath, id);
        if (!ok) return err(404, `未找到 worker id=${id}`);
        deps.requestSyncTasks?.();
        return { status: 200, body: { ok: true, id } };
      } catch (e) { return err(400, (e as Error).message); }
    },

    reorderWorkers(input: { ids?: string[] }): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理 worker)");
      if (!Array.isArray(input.ids)) return err(400, "ids 必填(数组)");
      try {
        const workers = workerStore.reorderWorkers(hubConfigPath, input.ids);
        deps.requestSyncTasks?.();
        return { status: 200, body: workers.map(workerToDto) };
      } catch (e) {
        return err(400, (e as Error).message);
      }
    },

    async testWorker(input: { kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): Promise<ApiResult> {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可测试 worker)");
      if (!deps.testWorker) return err(400, "hub 未启用(连接测试未注入)");
      try {
        const r = await deps.testWorker({ kind: input.kind ?? "", host: input.host, dataRoot: input.dataRoot, apiUrl: input.apiUrl });
        return { status: 200, body: r };
      } catch (e) {
        return { status: 200, body: { ok: false, error: (e as Error).message } satisfies WorkerTestResult };
      }
    },

    /** master 读某节点的任务清单(F3;只读,隐私投影无凭证)。失败回 200 + error,不让页面报错。 */
    async nodeTasks(workerId: string): Promise<ApiResult> {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可读节点任务)");
      if (!deps.nodeTasks) return err(400, "节点任务读取未注入");
      try {
        const r = await deps.nodeTasks(workerId);
        // 不把 webhook 送到浏览器(F3 只需要 id/名字来选任务;凭证类字段一律不透出)。
        return { status: 200, body: { ...r, tasks: r.tasks.map(({ webhook: _w, ...rest }) => rest) } };
      } catch (e) {
        return { status: 200, body: { workerId, tasks: [], error: (e as Error)?.message ?? String(e) } };
      }
    },

    /**
     * master 代查节点任务日志(F3)。只读;fleet 模式下节点网页日常不看,排查不必登节点。
     * 行数夹取(默认 200 / 上限 1000),防一次调用把上千行拖过 ssh 再灌进浏览器。
     */
    async nodeTaskLogs(workerId: string, taskId: number, lines?: number): Promise<ApiResult> {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可代查节点日志)");
      if (!deps.nodeTaskLogs) return err(400, "节点日志代查未注入");
      if (!Number.isFinite(taskId) || taskId <= 0) return err(400, "taskId 非法");
      const n = Number.isFinite(lines) ? Math.min(1000, Math.max(1, Math.trunc(lines as number))) : 200;
      try {
        return { status: 200, body: await deps.nodeTaskLogs(workerId, taskId, n) };
      } catch (e) {
        // 探测失败也是**可观测性结果**:回 200 + error,让 UI 显示原因,而不是让页面报错。
        return { status: 200, body: { workerId, taskId, lines: [], error: (e as Error)?.message ?? String(e) } };
      }
    },

    async workersStatus(): Promise<ApiResult> {
      // 未注入(hub 未开)→ 空数组(卡片显示灰/无点,不报错)。
      if (!deps.probeAllWorkers) return { status: 200, body: [] as WorkerStatus[] };
      try {
        const list = await deps.probeAllWorkers();
        return { status: 200, body: list satisfies WorkerStatus[] };
      } catch {
        // 整体失败也回 200 空,前端 catch 保上次状态,不崩。
        return { status: 200, body: [] as WorkerStatus[] };
      }
    },
  };
}
