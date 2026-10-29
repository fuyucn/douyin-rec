/**
 * task-sync.ts — hub 受管录制任务的下发/对账(node 侧)。
 *
 * 身份不变量：跨节点匹配一律用 (platform, roomSlug)，sourceTaskId 只在 master 本机
 * tasks 表内有效。受管任务 = tasks 表的普通行 + `managedBy='hub'`；Web API/UI 禁止
 * 编辑、删除。删除走两阶段：先在录/启用的只置 enabled=false，等 daemon 自然停录后
 * 下一轮再 removeTask。
 */
import { platformForRoom, readOutputFormat, type ApplyTasksResult, type NodeTaskDTO, type RemoteTaskSpec } from "@drec/core";
import { writeManagedState } from "./managed-state.js";
import { APP_VERSION } from "./version.js";
import type { TaskStore } from "./store.js";

/** Serialized master-delivered zero-disk metadata (issue #331); null when the master sent none. */
function deliveryJson(spec: RemoteTaskSpec): string | null {
  return spec.zeroDiskDelivery ? JSON.stringify(spec.zeroDiskDelivery) : null;
}

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
      rollingUpload: t.rollingUpload,
      rollingEffective: t.rollingEffective,
      streamUpload: t.streamUpload,
      streamUploadSpool: t.streamUploadSpool,
      outputFormat: t.outputFormat,
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

/** 本节点是否已有该 (platform, roomSlug) 的 hub 受管任务(跨平台同名房间号不撞)。 */
/**
 * 本节点是否**已有**该 (platform, roomSlug) 的任务 —— 用于「enabled:false 只更新不新建」。
 *
 * ⚠️ **必须同时认「hub 受管任务」和「本机源任务」**(自审发现的历史 bug):
 * master 本机走 `adopt=false`,源任务的 `managedBy` 恒为 null。若这里只看 `managedBy==='hub'`,
 * 那么「把 local 从某房间的 workers 里移除」时,本机会被误判成「从未有过该房间」而**跳过停用**,
 * 于是 master 继续录 —— 用户以为已经切到单节点,实际还在双录(实测:老目录持续增长 459MB)。
 * 判据必须是「这个房间在本节点有没有任务」,与它是否受管无关。
 */
function hasLocalTask(store: TaskStore, spec: RemoteTaskSpec): boolean {
  return store.listTasks().some((t) => {
    const s = slugOf(t.room);
    return s.platform === spec.platform && s.roomSlug === spec.roomSlug;
  });
}

/** env 强制开关(`DREC_ALLOW_SHRINK=1` / `true`),与 `opts.force` 等价。 */
function envAllowsShrink(): boolean {
  return envFlag("DREC_ALLOW_SHRINK");
}

/**
 * `DREC_EXPLICIT_DELETE=1` 才采信 `RemoteTaskSpec.deleted` 提示(跳过两阶段直接删)。
 *
 * **默认关**,这是有意的:删除的第一真理源是「节点 store 受管任务 − 期望 keys」,
 * 采信 master 的删除提示等于把「master 一次配置读失败 = 全节点任务被删」的风险重新引回来。
 * 开了它也只是「提前一轮」,不会让本来不删的东西开始删(仍然要求该 key 真的不在期望里)。
 */
function envExplicitDelete(): boolean {
  return envFlag("DREC_EXPLICIT_DELETE");
}

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
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
 *
 * **删除语义矩阵**(T3;唯一真理源 = 函数体内删除循环处的注释):
 * | master 侧表达            | 本节点行为                                   |
 * |-------------------------|----------------------------------------------|
 * | 期望含 enabled:true      | 新建/更新并启用                              |
 * | 期望含 enabled:false     | **停用但保留**任务(不删、不新建)              |
 * | 期望缺席(规则消失/解绑)  | 两阶段删除:先停用,下一轮真删                 |
 * | 期望含 deleted:true      | 一律当缺席;关=两阶段删,`DREC_EXPLICIT_DELETE=1`=直接删 |
 * | force / DREC_ALLOW_SHRINK| 合法缩容/清空,跳过骤减守卫照常删              |
 * 「禁用」与「删除」必须分开:取消勾选一个 worker、临时停用一条规则都**不该**删掉节点上的任务。
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

  // T3:deleted:true 的条目**一律不算「还在期望里」**(= 缺席),开关只决定「缺席后是否跳过第 1 轮」。
  //
  // 为什么两种情况都先当缺席(而不是「开关关就完全忽略该字段」):忽略 = 把它当正常期望条目
  // upsert,于是 upsert 会把一个「已删除的房间」重新建出来/重新启用 —— 比不删更糟(自审发现:
  // 第一版按「忽略」实现,测试里 deleted+enabled:true 的条目把任务又 enable 回来了)。
  // 当缺席处理则两种开关状态都安全:关=两阶段删除(默认口径),开=直接删。
  const explicitDelete = envExplicitDelete();
  const deletedKeys = new Set(
    desired.filter((d) => d.deleted === true).map((d) => `${d.platform}:${d.roomSlug}`),
  );
  /** 真正「要保持存在」的期望 keys(deleted 条目已剔除)。 */
  const retainedKeys = new Set([...desiredKeys].filter((k) => !deletedKeys.has(k)));

  /**
   * 立即删除 master 显式标记 `deleted:true` 的受管任务(仅 DREC_EXPLICIT_DELETE=1 时调用)。
   * 跳过两阶段:用户已在 master 侧确认「这个房间不要了」,再等一轮只会让旧节点多录一会儿。
   * 闭包而非模块级函数:deletedKeys 是**本轮**的推导结果,不该有任何跨调用的可变状态。
   */
  const removeDeleted = (): void => {
    for (const t of store.listTasks()) {
      if (t.managedBy !== "hub") continue;
      const s = slugOf(t.room);
      const key = `${s.platform}:${s.roomSlug}`;
      if (!deletedKeys.has(key)) continue;
      store.removeTask(t.id);
      removed.push(key);
      log?.(`[task-sync] 显式删除受管任务 ${t.id}: ${key}(deleted:true,DREC_EXPLICIT_DELETE=1)`);
    }
  };
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
        // 边录边传:旧开关随 master 下发(远端 = 生效值,兼容旧节点包;本机 = 用户旧值),
        // 生效值由 master 算好下发(issue #40),节点只存不判;旧 master 不带该字段 → 回落旧开关(旧行为)。
        rollingUpload: spec.rollingUpload,
        rollingEffective: spec.rollingEffective ?? spec.rollingUpload,
        // 0 落盘边录边传(plans/039):普通用户开关,旧 master 不带 → false(行为不变)。
        streamUpload: spec.streamUpload ?? false,
        streamUploadSpool: spec.streamUploadSpool ?? true,
        // Zero-disk metadata (issue #331): store what the master ships as-is (raw JSON, parsed strictly at the use
        // site); not shipped -> null. Overwritten every round, so a rule change (visibility / title template)
        // reaches the node on the next sync.
        zeroDiskDelivery: deliveryJson(spec),
        // 旧 master 不下发 / 非白名单值 → original(现状);不抛,免得一个坏值拒掉整批同步。
        outputFormat: readOutputFormat(spec.outputFormat),
      });
      log?.(`[task-sync] 收编任务 ${existing.id}: ${key}`);
      // 期望任务已禁用但节点上还在录/待起:必须硬停,不能等 daemon 排空到自然收播。
      // 否则 hub reconcile 的 settle 会一直卡在这场直播,迟迟不建 run。
      if (!spec.enabled && (existing.status === "running" || existing.status === "pending" || existing.status === "draining")) {
        pending.push(key);
        log?.(`[task-sync] 停用运行中任务 ${existing.id}: ${key}`);
      }
    } else {
      const created = store.addTask({
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
        rollingUpload: spec.rollingUpload,
        streamUpload: spec.streamUpload ?? false,
        streamUploadSpool: spec.streamUploadSpool ?? true,
        zeroDiskDelivery: deliveryJson(spec),
        outputFormat: readOutputFormat(spec.outputFormat),
      });
      store.updateTask(created.id, { rollingEffective: spec.rollingEffective ?? spec.rollingUpload });
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
    // 「被移出期望」= 不在 retainedKeys 里(缺席,或带 deleted 提示)。
    // 显式删除比「骤减」更强,所以 deleted 的房间不进守卫的 disableOnly,由删除循环直接处理。
    const disableOnly = () =>
      managedTasks
        .filter((t) => !retainedKeys.has(`${slugOf(t.room).platform}:${slugOf(t.room).roomSlug}`))
        .filter((t) => !deletedKeys.has(`${slugOf(t.room).platform}:${slugOf(t.room).roomSlug}`))
        .filter((t) => t.enabled || liveStatuses.has(t.status))
        .map((t) => ({ id: t.id, key: `${slugOf(t.room).platform}:${slugOf(t.room).roomSlug}` }));

    if (retainedKeys.size === 0 && !explicitDelete) {
      return { rejected: "empty-desired", totalManaged, enabledManaged, disableOnly: disableOnly() };
    }
    // enabledManaged ≤ 1 时不存在「数量级塌陷」(1→0 已被空期望守卫覆盖),不拦。
    if (enabledManaged <= 1) return null;
    if (retainedKeys.size > Math.floor(enabledManaged * SHRINK_RATIO)) return null;
    return { rejected: "mass-shrink", totalManaged, enabledManaged, disableOnly: disableOnly() };
  };

  // 显式删除先于守卫执行:master 逐个房间点名 deleted:true 是**明确意图**,不该被
  // 「期望骤减」或「空期望」守卫拦成「只停用」或直接丢弃(自审发现:守卫分支早退时
  // deleted 条目被无声忽略,用户点了删除却什么都没发生)。
  if (explicitDelete && deletedKeys.size > 0) removeDeleted();

  const guard = decideGuard();
  if (guard) {
    if (guard.rejected === "empty-desired") {
      // 空期望:连「停用」都不做 —— 此刻 master 状态不可信,任何写操作都可能把损失扩大
      // (自审发现:曾在这里之前先跑 disableOnly,结果是「一个都没删、却全被停用」,
      //  比原来的 bug 更难察觉 —— 任务还在、也不录了)。判定与执行严格按分支隔离。
      log?.(`[task-sync] 拒绝整轮下发:期望为空但本地有 ${guard.totalManaged} 个受管任务(rejected=empty-desired);`
        + `疑似 master 配置不可读;确认要清空请用 force / DREC_ALLOW_SHRINK=1`);
      return { applied, removed, pending: [], rejected: guard.rejected };
    }
    // 骤减:只停用不删除(语义同两阶段删除)—— 下一轮仍然骤减才继续,用户确认后 force 即真删。
    for (const { id, key } of guard.disableOnly) {
      store.setEnabled(id, false);
      pending.push(key);
    }
    log?.(`[task-sync] 期望骤减 ${retainedKeys.size}/${guard.enabledManaged}(≤ ${Math.floor(guard.enabledManaged * SHRINK_RATIO)}):`
      + `${guard.disableOnly.length} 个受管任务只停用不删除(rejected=mass-shrink);`
      + `确认要缩容请用 force / DREC_ALLOW_SHRINK=1`);
    for (const spec of desired) {
      // deleted 条目不下发(它是删除提示、不是配置);enabled:false 只更新不新建(见正常路径注释)。
      if (deletedKeys.has(`${spec.platform}:${spec.roomSlug}`)) continue;
      if (spec.enabled === false && !hasLocalTask(store, spec)) continue;
      upsert(spec, `${spec.platform}:${spec.roomSlug}`);
    }
    writeSnapshot(opts, desired, log);
    return { applied, removed, pending, rejected: guard.rejected };
  }

  for (const spec of desired) {
    // deleted 条目不下发(它是删除提示、不是配置):upsert 会先把它「复活」再删。
    if (deletedKeys.has(`${spec.platform}:${spec.roomSlug}`)) continue;
    // T3:enabled:false 的条目是「停用保留」信号,**只对本节点已有的受管任务有意义**。
    // 若无脑新建,一个从未录过该房间的节点会凭空长出一个 disabled 的 hub 受管任务
    // (自审发现:master 对每个 worker 都发 enabled:false,包括没被派发过的那些),
    // 这些幽灵任务会长期占着 UI 列表、还让 T2 的 totalManaged 基线虚高。
    // 语义 = upsert,但**只更新不新建**。
    if (spec.enabled === false && !hasLocalTask(store, spec)) continue;
    upsert(spec, `${spec.platform}:${spec.roomSlug}`);
  }

  for (const t of store.listTasks()) {
    if (t.managedBy !== "hub") continue;
    const s = slugOf(t.room);
    const key = `${s.platform}:${s.roomSlug}`;
    // T3 语义矩阵(唯一真理源 = 下面这几行;文档与测试都以此为准):
    //   期望里有且 enabled:false → 停用但**保留**任务(规则还在,只是不录了)
    //   期望里没有(缺席)          → 两阶段删除(先停,下轮真删),受 T2 守卫保护
    //   deleted:true(开关已开)    → 跳过第 1 轮直接删(用户已确认)
    //   force / DREC_ALLOW_SHRINK  → 合法缩容/清空,跳过守卫照常删
    if (retainedKeys.has(key)) continue;
    // 开关开:交给 removeDeleted 直接删(不走两阶段)。
    // 开关关:deleted 条目按**普通缺席**处理 —— 即两阶段删除(与「规则消失」完全同一条路径)。
    if (deletedKeys.has(key) && explicitDelete) continue;
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

/** 审计快照(T-1)落盘:记录本轮期望。**失败只 warn,绝不影响任务下发结果** ——
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
      // T16:同时记下「是哪个 bundle 版本应用了这份期望」,供 _node-status 回吐做版本漂移告警。
      appVersion: APP_VERSION,
      desired: [...desired],
    });
  } catch (e) {
    log?.(`[task-sync] 写审计快照失败(忽略): ${(e as Error)?.message ?? e}`);
  }
}
