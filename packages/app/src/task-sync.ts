/**
 * task-sync.ts — hub 受管录制任务的下发/对账(node 侧)。
 *
 * 身份不变量：跨节点匹配一律用 (platform, roomSlug)，sourceTaskId 只在 master 本机
 * tasks 表内有效。受管任务 = tasks 表的普通行 + `managedBy='hub'`；Web API/UI 禁止
 * 编辑、删除。删除走两阶段：先在录/启用的只置 enabled=false，等 daemon 自然停录后
 * 下一轮再 removeTask。
 */
import { platformForRoom, type ApplyTasksResult, type NodeTaskDTO, type RemoteTaskSpec } from "@drec/core";
import { writeManagedState } from "./managed-state.js";
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

// 契约在 core(orchestrator 的 transport 也用同一形状);这里 re-export 保持既有调用点不变。
export type { ApplyTasksResult } from "@drec/core";

/**
 * 骤减判定阈值(plans/030 经 7 轮评审定稿):期望 **≤ floor(enabled 受管数 / 2)** 即视为骤减。
 *
 * `2 → 1` 也算骤减是有意的:这一档最常见于「master 只读到部分规则 / 某个 worker 读失败」。
 * 它不会造成卡死 —— 被拦的那一轮只停用不删,下一轮 enabledManaged 降下来就放行真删
 * (若用户确实想立刻删,`force` 是显式出口)。
 */
const SHRINK_RATIO = 0.5;

/** env 强制开关(`DREC_ALLOW_SHRINK=1` / `true`),与 `opts.force` 等价。 */
function envAllowsShrink(): boolean {
  const v = (process.env.DREC_ALLOW_SHRINK ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface ApplyTasksOptions {
  /**
   * 是否把本节点已有的同名任务收编为 hub 受管(managedBy='hub')。
   * 远端节点默认 true；master 本地(local worker)传 false → 本机任务保持用户可编辑(managedBy=null)。
   */
  adopt?: boolean;
  /**
   * 「上次成功应用」审计快照的落盘目录（`<dir>/rooms.json`）。
   *
   * **必须由调用方显式传入**：远端 `_apply-tasks <dataRoot>` 只带 dataRoot、不带
   * DOUYIN_REC_ROOT，从环境推导会把快照写到错误的根，使可观测/版本回执失效。
   *
   * 省略 = 不写快照（既有调用点零副作用）。快照**仅供审计与版本回执**，
   * 删除判定用的是「store 受管任务 − 期望 keys」，不是快照 diff（快照 ≡ 期望，diff 恒空）。
   */
  managedStateDir?: string;
  /** 期望版本号（master 单调递增）；随快照一起落盘，供 UI 显示版本漂移。 */
  expectedVersion?: number;
  /**
   * **强制应用**：跳过空期望/骤减守卫。
   *
   * 为什么必须有:守卫会拦下「期望 N→0」这类**合法**操作 —— 例如把房间从 VPS1 重新分配到
   * VPS2(T-17 场景),旧节点本轮就该清空。没有显式出口,合法缩容会被永久拒绝、旧节点继续双录。
   * 等价开关:目标节点环境变量 `DREC_ALLOW_SHRINK=1`。
   */
  force?: boolean;
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
  const force = opts.force === true || envAllowsShrink();

  const upsert = (spec: RemoteTaskSpec, key: string): void => {
    const existing = store.listTasks().find((t) => {
      const s = slugOf(t.room);
      return s.platform === spec.platform && s.roomSlug === spec.roomSlug;
    });
    if (existing) {
      // 远端:收编为受管;master 本地:保持用户可编辑(顺带清掉历史遗留的 hub 标记)。
      // 保留 node 本地 cookies/useCookie/outDir/webhook。
      store.setManagedBy(existing.id, adopt ? "hub" : null);
      // **不下发 anchorName**(T-4):主播名由各节点**自行维护**——worker 录制时从
      // `[主播] xxx` 日志抓取并持久化(task-manager),master 侧只在创建/改房间时抓一次、
      // 之后可能长期为 null。若这里带 `anchorName: spec.anchorName ?? null`,master 的 null
      // 会覆盖 worker 已抓到的正确值,界面上主播名凭空消失。故更新时**完全不动**该字段。
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
        // 新建时预置 master 的 anchorName(如非 null),避免 Waiting 阶段一直显示房间号。
        // 录制开始后 worker 会从 [主播] 日志抓取真实值并覆盖,不影响精度。
        // 注意:这只对新建生效;更新现有任务时刻意不动 anchorName(见上方注释),
        // 防止 master 的 null 覆盖 worker 已抓到的正确值。
        anchorName: spec.anchorName ?? null,
      });
      log?.(`[task-sync] ${adopt ? "新建受管任务" : "新建本机任务"}: ${key}`);
    }
    applied.push(key);
  };

  // ── 安全阀(必须在 upsert 定义之后求值,否则 TDZ):防止「master 读不到规则」被当成「用户要删」 ──
  // 背景:master 侧 listHubRules 目录不可读/坏 JSON 时历史行为是 catch→[] → desired 空 →
  // 下面「缺席即两阶段删除」会把本节点受管任务删光(2026-10-09 实测复现,plans/029 §9.2)。
  //
  // 两个基线刻意不同:
  //   totalManaged   = 全部受管任务(**含已 disabled**)→ 驱动「空期望」守卫。若用 enabled 口径,
  //                    一个全是停用任务的节点在 master 异常时会绕过守卫被删空。
  //   enabledManaged = 其中 enabled 的 → 只驱动「骤减比例」守卫,避免大量正常停用被误判为骤减。
  const managedTasks = store.listTasks().filter((t) => t.managedBy === "hub");
  const totalManaged = managedTasks.length;
  const enabledManaged = managedTasks.filter((t) => t.enabled).length;
  const liveStatuses = new Set(["running", "pending", "draining"]);

  type Guard =
    | { rejected: "empty-desired"; totalManaged: number; enabledManaged: number; disableOnly: Array<{ id: number; key: string }> }
    | { rejected: "mass-shrink"; totalManaged: number; enabledManaged: number; disableOnly: Array<{ id: number; key: string }> };

  /**
   * 纯判定(无副作用):返回非 null 表示本轮下发被安全阀拦下。
   * 判定与执行分离,便于测试边界。`disableOnly` = 本轮只置 enabled=false 的受管任务
   * (语义与下面的两阶段删除完全一致:启用中/在录的先停,等下一轮确认后才真删)。
   */
  const decideGuard = (): Guard | null => {
    if (force || totalManaged === 0) return null;
    const disableOnly = () =>
      managedTasks
        .filter((t) => !desiredKeys.has(`${slugOf(t.room).platform}:${slugOf(t.room).roomSlug}`))
        .filter((t) => t.enabled || liveStatuses.has(t.status))
        .map((t) => ({ id: t.id, key: `${slugOf(t.room).platform}:${slugOf(t.room).roomSlug}` }));

    if (desired.length === 0) {
      return { rejected: "empty-desired", totalManaged, enabledManaged, disableOnly: disableOnly() };
    }
    // enabledManaged ≤ 1 时不存在「数量级塌陷」(1→0 已被空期望守卫覆盖),不拦。
    if (enabledManaged <= 1) return null;
    if (desired.length > Math.floor(enabledManaged * SHRINK_RATIO)) return null;
    return { rejected: "mass-shrink", totalManaged, enabledManaged, disableOnly: disableOnly() };
  };

  const guard = decideGuard();
  if (guard) {
    if (guard.rejected === "empty-desired") {
      // 空期望:连「停用」都不做 —— 此刻 master 状态不可信,任何写操作都可能把损失扩大
      // (自审发现:曾在这里之前先跑 disableOnly,结果是「一个都没删、却全被停用」,
      //  比原来的 bug 更难察觉 —— 任务还在、也不录了)。判定与执行严格按分支隔离。
      log?.(`[task-sync] 拒绝整轮下发:期望为空但本地有 ${guard.totalManaged} 个受管任务(rejected=empty-desired);`
        + `疑似 master 配置不可读;确认要清空请用 force / DREC_ALLOW_SHRINK=1`);
      return { applied, removed: [], pending: [], rejected: guard.rejected };
    }
    // 骤减:只停用不删除(语义同两阶段删除)—— 下一轮仍然骤减才继续,用户确认后 force 即真删。
    for (const { id, key } of guard.disableOnly) {
      store.setEnabled(id, false);
      pending.push(key);
    }
    log?.(`[task-sync] 期望骤减 ${desired.length}/${guard.enabledManaged}(≤ ${Math.floor(guard.enabledManaged * SHRINK_RATIO)}):`
      + `${guard.disableOnly.length} 个受管任务只停用不删除(rejected=mass-shrink);`
      + `确认要缩容请用 force / DREC_ALLOW_SHRINK=1`);
    for (const spec of desired) upsert(spec, `${spec.platform}:${spec.roomSlug}`);
    writeSnapshot(opts, desired, log);
    return { applied, removed: [], pending, rejected: guard.rejected };
  }

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

  writeSnapshot(opts, desired, log);

  return { applied, removed, pending };
}

/**
 * 审计快照(T-1)落盘:记录本轮期望。**失败只 warn,绝不影响任务下发结果** ——
 * 快照是运维可观测产物,不是应用成功的前提(与「写快照失败 → 抛错 → master 以为下发失败
 * → 重试 → 重复停用/删除」的历史故障保持隔离)。
 */
function writeSnapshot(
  opts: ApplyTasksOptions,
  desired: RemoteTaskSpec[],
  log?: (msg: string) => void,
): void {
  if (!opts.managedStateDir) return;
  try {
    writeManagedState(opts.managedStateDir, {
      version: opts.expectedVersion ?? 0,
      desired: [...desired],
    });
  } catch (e) {
    log?.(`[task-sync] 写审计快照失败(忽略): ${(e as Error)?.message ?? e}`);
  }
}
