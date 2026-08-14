/**
 * task-sync.ts — hub 受管录制任务的下发/对账(node 侧)。
 *
 * 身份不变量：跨节点匹配一律用 (platform, roomSlug)，sourceTaskId 只在 master 本机
 * tasks 表内有效。受管任务 = tasks 表的普通行 + `managedBy='hub'`；Web API/UI 禁止
 * 编辑、删除。删除走两阶段：先在录/启用的只置 enabled=false，等 daemon 自然停录后
 * 下一轮再 removeTask。
 */
import { platformForRoom, type NodeTaskDTO, type RemoteTaskSpec } from "@drec/core";
import type { TaskStore } from "./store.js";

function slugOf(room: string): { platform: string; roomSlug: string } {
  const p = platformForRoom(room);
  return { platform: p.id, roomSlug: p.extractRoomSlug(room) };
}

/** `_tasks` 隐藏子命令 / local transport 的输出：节点上全部任务的隐私安全投影(无 cookies)。 */
export function listNodeTasks(store: TaskStore): NodeTaskDTO[] {
  return store.listTasks().map((t) => {
    const { platform, roomSlug } = slugOf(t.room);
    return {
      id: t.id,
      platform,
      roomSlug,
      room: t.room,
      name: t.name,
      quality: t.quality,
      engine: t.engine,
      danmu: t.danmu,
      segmentSec: t.segmentSec,
      scheduleStart: t.scheduleStart,
      scheduleEnd: t.scheduleEnd,
      status: t.status,
      useCookie: t.useCookie,
      enabled: t.enabled,
      outDir: t.outDir,
      webhook: t.webhook,
      managedBy: t.managedBy,
      anchorName: t.anchorName,
    };
  });
}

export interface ApplyTasksResult {
  /** 已创建 / 已收编更新的 (platform:roomSlug) 列表。 */
  applied: string[];
  /** 已删除的 (platform:roomSlug) 列表。 */
  removed: string[];
  /** 已置 enabled=false、等待收播后下轮删除的 (platform:roomSlug) 列表。 */
  pending: string[];
}

export interface ApplyTasksOptions {
  /**
   * 是否把本节点已有的同名任务收编为 hub 受管(managedBy='hub')。
   * 远端节点默认 true；master 本地(local worker)传 false → 本机任务保持用户可编辑(managedBy=null)。
   */
  adopt?: boolean;
}

/**
 * 把 master 下发的期望任务应用到本节点：
 *  - 已存在同名任务 → 默认收编(managedBy='hub')并更新除 per-node override 外的全部字段；
 *    adopt=false(master 本地)→ 保持用户可编辑并清掉历史遗留的 hub 标记；
 *  - 不存在 → 新建；
 *  - 受管但不在 desired 的任务 → 两阶段删除。
 * per-node override = cookies / useCookie / outDir / webhook(保留 node 本地配置)。
 */
export function applyRemoteTasks(
  store: TaskStore,
  desired: RemoteTaskSpec[],
  log?: (msg: string) => void,
  opts: ApplyTasksOptions = {},
): ApplyTasksResult {
  const adopt = opts.adopt !== false;
  const applied: string[] = [];
  const removed: string[] = [];
  const pending: string[] = [];
  const desiredKeys = new Set(desired.map((d) => `${d.platform}:${d.roomSlug}`));

  const upsert = (spec: RemoteTaskSpec, key: string): void => {
    const existing = store.listTasks().find((t) => {
      const s = slugOf(t.room);
      return s.platform === spec.platform && s.roomSlug === spec.roomSlug;
    });
    if (existing) {
      // 远端:收编为受管;master 本地:保持用户可编辑(顺带清掉历史遗留的 hub 标记)。
      // 保留 node 本地 cookies/useCookie/outDir/webhook。
      store.setManagedBy(existing.id, adopt ? "hub" : null);
      store.updateTask(existing.id, {
        room: spec.room,
        name: spec.name ?? null,
        quality: spec.quality,
        engine: spec.engine,
        danmu: spec.danmu,
        segmentSec: spec.segmentSec,
        scheduleStart: spec.scheduleStart,
        scheduleEnd: spec.scheduleEnd,
        enabled: spec.enabled,
        anchorName: spec.anchorName ?? null,
      });
      log?.(`[task-sync] 收编任务 ${existing.id}: ${key}`);
      // 期望任务已禁用但节点上还在录/待起:必须硬停,不能等 daemon 排空到自然收播。
      // 否则 hub reconcile 的 settle 会一直卡在这场直播,迟迟不建 run。
      if (!spec.enabled && (existing.status === "running" || existing.status === "pending" || existing.status === "draining")) {
        pending.push(key);
        log?.(`[task-sync] 停用运行中任务 ${existing.id}: ${key}`);
      }
    } else {
      store.addTask({
        room: spec.room,
        name: spec.name ?? null,
        quality: spec.quality,
        engine: spec.engine,
        danmu: spec.danmu,
        segmentSec: spec.segmentSec,
        scheduleStart: spec.scheduleStart,
        scheduleEnd: spec.scheduleEnd,
        cookies: spec.cookies,
        useCookie: spec.useCookie,
        outDir: spec.outDir,
        webhook: spec.webhook,
        enabled: spec.enabled,
        managedBy: adopt ? "hub" : null,
        anchorName: spec.anchorName ?? null,
      });
      log?.(`[task-sync] ${adopt ? "新建受管任务" : "新建本机任务"}: ${key}`);
    }
    applied.push(key);
  };

  for (const spec of desired) upsert(spec, `${spec.platform}:${spec.roomSlug}`);

  for (const t of store.listTasks()) {
    if (t.managedBy !== "hub") continue;
    const s = slugOf(t.room);
    const key = `${s.platform}:${s.roomSlug}`;
    if (desiredKeys.has(key)) continue;
    // 两阶段删除:启用的(daemon 还会拉起)或正在录的只先停;等 daemon 自然收播后下轮删。
    if (t.enabled || t.status === "running" || t.status === "pending" || t.status === "draining") {
      store.setEnabled(t.id, false);
      pending.push(key);
      log?.(`[task-sync] 停用待删任务 ${t.id}: ${key}`);
    } else {
      store.removeTask(t.id);
      removed.push(key);
      log?.(`[task-sync] 删除受管任务 ${t.id}: ${key}`);
    }
  }

  return { applied, removed, pending };
}
