/**
 * task-sync.ts — hub 受管录制任务的下发/对账(node 侧)。
 *
 * 身份不变量：跨节点匹配一律用 (platform, roomSlug)，sourceTaskId 只在 master 本机
 * tasks 表内有效。受管任务 = tasks 表的普通行 + `managedBy='hub'`；Web API/UI 禁止
 * 编辑、删除。删除走两阶段：先在录/启用的只置 enabled=false，等 daemon 自然停录后
 * 下一轮再 removeTask。
 */
import { platformForRoom, readOutputFormat, STREAM_UPLOAD_SPOOL_REQUIRED, type ApplyTasksResult, type NodeTaskDTO, type RemoteTaskSpec } from "@drec/core";
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

/**
 * Issue #480: best-effort slug of a room that may come from an untrusted source (a master spec or an old
 * local task row). Returns null instead of throwing: a malformed room must never abort a whole batch.
 */
function trySlugOf(room: unknown): { platform: string; roomSlug: string } | null {
  if (typeof room !== "string" || !room.trim()) return null;
  try {
    const s = slugOf(room);
    return s.platform && s.roomSlug ? s : null;
  } catch {
    return null;
  }
}

/** A master spec that failed validation; `index` is its position in the delivered batch (no cookies are logged). */
export interface SkippedTaskSpec { index: number; room?: string; reason: string }

/**
 * Validate ONE delivered spec (issue #480). A malformed item (master bug / truncated payload) is skipped and
 * logged instead of aborting the batch, so every other room on this node is still applied.
 */
function validateSpec(raw: unknown): { ok: true; spec: RemoteTaskSpec } | { ok: false; room?: string; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "不是对象" };
  const spec = raw as Partial<RemoteTaskSpec>;
  const room = typeof spec.room === "string" ? spec.room.trim() : "";
  if (!room) return { ok: false, reason: "缺少 room" };
  const slug = trySlugOf(room);
  if (!slug) return { ok: false, room, reason: "room 无法解析出房间身份" };
  if (typeof spec.platform !== "string" || !spec.platform.trim()) return { ok: false, room, reason: "缺少 platform" };
  if (typeof spec.roomSlug !== "string" || !spec.roomSlug.trim()) return { ok: false, room, reason: "缺少 roomSlug" };
  // The trimmed value is only a validation aid: the stored spec keeps the master's bytes untouched, so an
  // all-good batch stays byte-identical (issue #480 review).
  return { ok: true, spec: spec as RemoteTaskSpec };
}

/** `_tasks` 隐藏子命令 / local transport 的输出：节点上全部任务的隐私安全投影(无 cookies)。 */
export function listNodeTasks(store: TaskStore): NodeTaskDTO[] {
  // A local row whose room cannot be parsed is skipped instead of aborting the whole projection: one bad
  // legacy row must not make this node invisible to the master (issue #480 review).
  return store.listTasks().flatMap((t) => {
    const slug = trySlugOf(t.room);
    if (!slug) return [];
    const { platform, roomSlug } = slug;
    return [{
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
    }];
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
    const s = trySlugOf(t.room);
    return !!s && s.platform === spec.platform && s.roomSlug === spec.roomSlug;
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
   * 每房间 key 的「旧 master 下发已废弃的真 0 落盘」去重集合；跨调用持久，同一房间
   * 反复下发 false 也只告警一次。省略 = 每次调用独立（测试/单批场景行为不变）。
   */
  noSpoolWarnedKeys?: Set<string>;
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
 * **删除语义矩阵**(T3 + #442;唯一真理源 = 函数体内删除循环处的注释):
 * | master 侧表达                      | 本节点行为                                   |
 * |-----------------------------------|----------------------------------------------|
 * | 期望含 enabled:true                 | 新建/更新并启用                              |
 * | 期望含 enabled:false(未点名删除)    | **停用但保留**任务(不删、不新建)              |
 * | 期望含 deleted:true(#442 点名)      | 两阶段删除:先停用,下一轮真删(env 开=直接删) |
 * | 期望缺席(规则消失/解绑)             | 两阶段删除:先停用,下一轮真删                 |
 * | force / DREC_ALLOW_SHRINK           | 合法缩容/清空,跳过骤减守卫照常删              |
 * 「禁用」与「删除」必须分开:临时停用一条规则都**不该**删掉节点上的任务;
 * 而「取消勾选」(#442)是用户明确的重配意图,master 会点名 deleted:true(守卫放行,见 decideGuard)。
 */
export function applyRemoteTasks(
  store: TaskStore,
  desired: RemoteTaskSpec[],
  log?: (msg: string) => void,
  opts: ApplyTasksOptions = {},
): ApplyTasksResult {
  const adopt = opts.adopt !== false;
  /** One-shot compatibility warning per room key for a legacy no-spool delivery. */
  const warnedNoSpool = opts.noSpoolWarnedKeys ?? new Set<string>();
  /** 兼容告警随回执 warnings 上抛:短命 _apply-tasks 进程的 logger 不可靠,master 侧打印。 */
  const warnings: string[] = [];
  const applied: string[] = [];
  const removed: string[] = [];
  const pending: string[] = [];

  // Issue #480: validate each delivered spec on its own. One malformed item (master bug / truncated payload)
  // must not abort the batch, so the remaining rooms are still applied. Cookies are never logged.
  const skipped: SkippedTaskSpec[] = [];
  const valid: RemoteTaskSpec[] = [];
  desired.forEach((raw, index) => {
    const v = validateSpec(raw);
    if (v.ok) { valid.push(v.spec); return; }
    skipped.push({ index, ...(v.room ? { room: v.room } : {}), reason: v.reason });
    log?.(`[task-sync] 跳过第 ${index + 1} 条期望(room=${v.room ?? "-"}): ${v.reason}`);
  });
  if (skipped.length > 0) {
    log?.(`[task-sync] 本轮期望 ${desired.length} 条,跳过 ${skipped.length} 条坏条目;其余照常应用`);
  }

  const desiredKeys = new Set(valid.map((d) => `${d.platform}:${d.roomSlug}`));
  const force = opts.force === true || envAllowsShrink();

  // T3:deleted:true 的条目**一律不算「还在期望里」**(= 缺席),开关只决定「缺席后是否跳过第 1 轮」。
  //
  // 为什么两种情况都先当缺席(而不是「开关关就完全忽略该字段」):忽略 = 把它当正常期望条目
  // upsert,于是 upsert 会把一个「已删除的房间」重新建出来/重新启用 —— 比不删更糟(自审发现:
  // 第一版按「忽略」实现,测试里 deleted+enabled:true 的条目把任务又 enable 回来了)。
  // 当缺席处理则两种开关状态都安全:关=两阶段删除(默认口径),开=直接删。
  const explicitDelete = envExplicitDelete();
  const deletedKeys = new Set(
    valid.filter((d) => d.deleted === true).map((d) => `${d.platform}:${d.roomSlug}`),
  );
  /** 真正「要保持存在」的期望 keys(deleted 条目已剔除)。 */
  const retainedKeys = new Set([...desiredKeys].filter((k) => !deletedKeys.has(k)));

  /**
   * Issue #480 delete-phase safety. A skipped item is **not** "absent from the desired set": deleting a local
   * managed task because its spec failed to parse would turn a master bug into data loss on the node.
   *  - every skipped item whose room slug is derivable -> those keys are protected (never deleted/disabled);
   *  - any skipped item whose room cannot be parsed at all -> the room is unknown, so we cannot tell which
   *    local task it belongs to: skip ALL deletions this round (keep every existing task untouched).
   * The upsert phase is unaffected: good specs are still applied and their rooms keep working.
   */
  const unknownSkipped = skipped.some((s) => !s.room || !trySlugOf(s.room));
  const protectedKeys = new Set<string>();
  for (const s of skipped) {
    const slug = s.room ? trySlugOf(s.room) : null;
    if (slug) protectedKeys.add(`${slug.platform}:${slug.roomSlug}`);
  }
  const skipDeletions = unknownSkipped;

  /**
   * 立即删除 master 显式标记 `deleted:true` 的受管任务(仅 DREC_EXPLICIT_DELETE=1 时调用)。
   * 跳过两阶段:用户已在 master 侧确认「这个房间不要了」,再等一轮只会让旧节点多录一会儿。
   * 闭包而非模块级函数:deletedKeys 是**本轮**的推导结果,不该有任何跨调用的可变状态。
   */
  const removeDeleted = (): void => {
    for (const t of store.listTasks()) {
      if (t.managedBy !== "hub") continue;
      const s = trySlugOf(t.room);
      if (!s) continue; // unparsable local row: never guess, never delete
      const key = `${s.platform}:${s.roomSlug}`;
      if (!deletedKeys.has(key)) continue;
      // A skipped spec for the same room means we cannot trust the "delete" outcome either. (The unknown-room
      // case never reaches this loop: the whole fast path is gated on !skipDeletions at the call site.)
      if (protectedKeys.has(key)) {
        log?.(`[task-sync] 保留受管任务 ${t.id}: ${key}(本轮该房间的期望条目无法解析,不删除)`);
        continue;
      }
      store.removeTask(t.id);
      removed.push(key);
      log?.(`[task-sync] 显式删除受管任务 ${t.id}: ${key}(deleted:true,DREC_EXPLICIT_DELETE=1)`);
    }
  };
  const upsert = (spec: RemoteTaskSpec, key: string): void => {
    const existing = store.listTasks().find((t) => {
      const s = trySlugOf(t.room);
      return !!s && s.platform === spec.platform && s.roomSlug === spec.roomSlug;
    });
      if ((spec.streamUpload ?? false) && spec.streamUploadSpool === false && !warnedNoSpool.has(key)) {
        warnedNoSpool.add(key);
        log?.(`[task-sync] 任务 ${existing?.id ?? "新建"}(${spec.platform}) 旧 master 下发了已废弃的真 0 落盘,已按保留回退文件运行`);
        warnings.push(`任务 ${existing?.id ?? "新建"}(${spec.platform}) 旧 master 下发了已废弃的真 0 落盘,已按保留回退文件运行`);
      }
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
        streamUploadSpool: STREAM_UPLOAD_SPOOL_REQUIRED,
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
        streamUploadSpool: STREAM_UPLOAD_SPOOL_REQUIRED,
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
    // #442:master 对每个被移出的受管任务**点名 deleted:true** = 明确的删除意图 —— master 只有
    // 读到了自己的配置才会逐房间点名;配置读不可信时 desired 连条目都不会有。这种缩容不走守卫:
    // 守卫保护的是「master 误读」(缺席但无点名),不是「用户明确要删」。
    const shrinkIsExplicit = managedTasks.every((t) => {
      const s = trySlugOf(t.room);
      if (!s) return false; // unknown local identity: never treat it as explicitly accounted for
      const k = `${s.platform}:${s.roomSlug}`;
      return retainedKeys.has(k) || deletedKeys.has(k);
    });
    if (shrinkIsExplicit) return null;
    // 「被移出期望」= 不在 retainedKeys 里(缺席,或带 deleted 提示)。
    // 显式删除比「骤减」更强,所以 deleted 的房间不进守卫的 disableOnly,由删除循环直接处理。
    const disableOnly = () =>
      managedTasks
        .filter((t) => {
          const s = trySlugOf(t.room);
          // Issue #480: a room whose delivered spec failed to parse is protected here too — the valve must not
          // disable what the deletion phase is told to leave alone.
          const key = s ? `${s.platform}:${s.roomSlug}` : "";
          return !!s && !retainedKeys.has(key) && !deletedKeys.has(key) && !protectedKeys.has(key);
        })
        .filter((t) => t.enabled || liveStatuses.has(t.status))
        .map((t) => {
          const s = trySlugOf(t.room)!;
          return { id: t.id, key: `${s.platform}:${s.roomSlug}` };
        });

    // Issue #480 (review 2): a protected key only counts toward "how much of the desired set survived" when
    // this node actually has a managed task for that room. A protected room the node never had is not a reason
    // to keep tasks for other rooms alive (a batch of unknown-room garbage must still be rejected).
    const localManagedKeys = new Set(
      managedTasks.flatMap((t) => {
        const s = trySlugOf(t.room);
        return s ? [`${s.platform}:${s.roomSlug}`] : [];
      }),
    );
    const expectedKeys = new Set([...retainedKeys, ...protectedKeys].filter((k) => {
      return retainedKeys.has(k) || localManagedKeys.has(k);
    }));
    const expectedSize = expectedKeys.size;
    if (retainedKeys.size === 0 && !explicitDelete && expectedSize === 0) {
      return { rejected: "empty-desired", totalManaged, enabledManaged, disableOnly: disableOnly() };
    }
    // enabledManaged ≤ 1 时不存在「数量级塌陷」(1→0 已被空期望守卫覆盖),不拦。
    if (enabledManaged <= 1) return null;
    if (expectedSize > Math.floor(enabledManaged * SHRINK_RATIO)) return null;
    return { rejected: "mass-shrink", totalManaged, enabledManaged, disableOnly: disableOnly() };
  };

  // 显式删除先于守卫执行:master 逐个房间点名 deleted:true 是**明确意图**,不该被
  // 「期望骤减」或「空期望」守卫拦成「只停用」或直接丢弃(自审发现:守卫分支早退时
  // deleted 条目被无声忽略,用户点了删除却什么都没发生)。
  // Issue #480: an unparsable item with an unknown room means we cannot tell which local task it belongs to,
  // so no deletion may run this round — including the explicit-delete fast path.
  if (explicitDelete && deletedKeys.size > 0 && !skipDeletions) removeDeleted();

  // With an unknown skipped room the deletion phase is skipped entirely, so the safety valves (which exist to
  // stop deletions/disables) must not fire either — they would disable tasks the round is meant to leave alone.
  const guard = skipDeletions ? null : decideGuard();
  if (guard) {
    if (guard.rejected === "empty-desired") {
      // 空期望:连「停用」都不做 —— 此刻 master 状态不可信,任何写操作都可能把损失扩大
      // (自审发现:曾在这里之前先跑 disableOnly,结果是「一个都没删、却全被停用」,
      //  比原来的 bug 更难察觉 —— 任务还在、也不录了)。判定与执行严格按分支隔离。
      log?.(`[task-sync] 拒绝整轮下发:期望为空但本地有 ${guard.totalManaged} 个受管任务(rejected=empty-desired);`
        + `疑似 master 配置不可读;确认要清空请用 force / DREC_ALLOW_SHRINK=1`);
      return { applied, removed, pending: [], rejected: guard.rejected, ...(warnings.length ? { warnings } : {}), ...(skipped.length ? { skipped } : {}) };
    }
    // 骤减:只停用不删除(语义同两阶段删除)—— 下一轮仍然骤减才继续,用户确认后 force 即真删。
    for (const { id, key } of guard.disableOnly) {
      store.setEnabled(id, false);
      pending.push(key);
    }
    log?.(`[task-sync] 期望骤减 ${retainedKeys.size}/${guard.enabledManaged}(≤ ${Math.floor(guard.enabledManaged * SHRINK_RATIO)}):`
      + `${guard.disableOnly.length} 个受管任务只停用不删除(rejected=mass-shrink);`
      + `确认要缩容请用 force / DREC_ALLOW_SHRINK=1`);
    for (const spec of valid) {
      // deleted 条目不下发(它是删除提示、不是配置);enabled:false 只更新不新建(见正常路径注释)。
      if (deletedKeys.has(`${spec.platform}:${spec.roomSlug}`)) continue;
      if (spec.enabled === false && !hasLocalTask(store, spec)) continue;
      upsert(spec, `${spec.platform}:${spec.roomSlug}`);
    }
    writeSnapshot(opts, valid, log, skipped);
    return { applied, removed, pending, rejected: guard.rejected, ...(warnings.length ? { warnings } : {}), ...(skipped.length ? { skipped } : {}) };
  }

  for (const spec of valid) {
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

  if (skipDeletions) {
    log?.(`[task-sync] 本轮有无法解析房间的期望条目,跳过全部删除/停用(保留 ${managedTasks.length} 个受管任务)`);
    writeSnapshot(opts, valid, log, skipped);
    return { applied, removed, pending, ...(warnings.length ? { warnings } : {}), ...(skipped.length ? { skipped } : {}) };
  }

  for (const t of store.listTasks()) {
    if (t.managedBy !== "hub") continue;
    const s = trySlugOf(t.room);
    if (!s) { log?.(`[task-sync] 跳过无法解析身份的受管任务 ${t.id}(不删除)`); continue; }
    const key = `${s.platform}:${s.roomSlug}`;
    // Issue #480: a skipped spec for this room is NOT "absent" — never delete/disable the local task.
    if (protectedKeys.has(key)) {
      log?.(`[task-sync] 保留受管任务 ${t.id}: ${key}(本轮期望里该房间的条目无法解析,不按缺席处理)`);
      continue;
    }
    // #442(rework-2,review 低危项):master 本机(adopt=false)上的 managedBy='hub' 只可能是旧版本
    // 同步的遗留标记,不是真正的受管任务 —— 清标记,绝不删源任务(点名/缺席都不删)。
    // 否则「未勾选本机的房间不再 upsert」后,遗留标记会让本机源任务走进两阶段删除。
    if (!adopt) {
      store.setManagedBy(t.id, null);
      log?.(`[task-sync] 清除本机遗留受管标记 ${t.id}: ${key}(不删除)`);
      continue;
    }
    // T3 + #442 语义矩阵(唯一真理源 = 下面这几行;文档与测试都以此为准):
    //   期望里有且 enabled:false(未点名删除) → 停用但**保留**任务(规则停用等可逆状态)
    //   期望里没有(缺席)                     → 两阶段删除(先停,下轮真删),受 T2 守卫保护
    //   deleted:true(#442 点名)              → 默认两阶段删除(先停,下轮真删);
    //                                          env 开(DREC_EXPLICIT_DELETE)=跳过第 1 轮直接删
    //   force / DREC_ALLOW_SHRINK             → 合法缩容/清空,跳过守卫照常删
    //   注意:守卫触发(误读保护)的那一轮,被点名但不在期望里的房间**既不停也不删**(保守,
    //   等误读消失后下一轮再走两阶段);与旧行为(enabled:false 会停)不同,属已知取舍。
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

  writeSnapshot(opts, valid, log, skipped);

  return { applied, removed, pending, ...(warnings.length ? { warnings } : {}), ...(skipped.length ? { skipped } : {}) };
}

/** 审计快照(T-1)落盘:记录本轮期望。**失败只 warn,绝不影响任务下发结果** ——
 * 快照是运维可观测产物,不是应用成功的前提(与「写快照失败 → 抛错 → master 以为下发失败
 * → 重试 → 重复停用/删除」的历史故障保持隔离)。
 */
function writeSnapshot(
  opts: ApplyTasksOptions,
  desired: RemoteTaskSpec[],
  log?: (msg: string) => void,
  skipped: SkippedTaskSpec[] = [],
): void {
  if (!opts.managedStateDir) return;
  try {
    writeManagedState(opts.managedStateDir, {
      version: opts.expectedVersion ?? 0,
      // T16:同时记下「是哪个 bundle 版本应用了这份期望」,供 _node-status 回吐做版本漂移告警。
      appVersion: APP_VERSION,
      // Only specs that actually applied: a malformed item must never look like an applied room (issue #480).
      desired: [...desired],
      ...(skipped.length ? { skipped } : {}),
    });
  } catch (e) {
    log?.(`[task-sync] 写审计快照失败(忽略): ${(e as Error)?.message ?? e}`);
  }
}
