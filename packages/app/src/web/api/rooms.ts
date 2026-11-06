/**
 * web/api/rooms.ts — **统一房间读写**(T9 / plans/030 c5)。
 *
 * 一个房间的配置物理上分两处:tasks 表(录制半边)+ `config/hub/{key}.json`(处理半边)。
 * 本域把两半聚合成一个可读写的单元,**不改物理存储** —— 旧 `/api/tasks` 与
 * `/api/hub/rules` 端点全部保留,前端可以逐步迁移。
 *
 * ## 为什么要有它
 * 前端改一个房间的画质+处理步骤,今天必须**连写两个接口**。中间任何一步失败都会留下
 * 半成功(「画质改了、处理没改」),而用户看不出是哪半边生效、也没法只重试那一半。
 *
 * ## 写入顺序与回滚
 * 先写 task、再写 hub 规则。第二步失败时**回滚第一步**(把 task 恢复成写之前的值),
 * 然后返回 500 + 原因。代价是:若回滚本身也失败,仍可能留下半成功 —— 这种情况下
 * 错误信息必须**明说哪半边可能已改**,让用户能自己核对(静默留半成功是不可接受的)。
 */
import { parseOutputFormat, platformForRoom, redactTaskSecrets, streamUploadConflicts, type RoomDTO, type RoomPayload, type RoomRecordingDTO, type HubRulePayload } from "@drec/core";
import { nodeOutputFormatLock } from "../../node-remux.js";
import type { ApiCtx } from "./context.js";
import type { ApiResult, CreateRoomInput } from "./types.js";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import * as hubStore from "../../hub-store.js";
import { activeHubJobKeys, deleteHubJobHistory } from "../../hub-jobs.js";
import type { Task, TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";

type RecordingPatch = Parameters<TaskStore["updateTask"]>[1];
// Every writable key is a Task column, so a rollback can always read it from the snapshot.
type RecordingKey = keyof RecordingPatch & keyof Task;
const _patchKeysAreTaskFields: [Exclude<keyof RecordingPatch, keyof Task>] extends [never] ? true : never = true;
void _patchKeysAreTaskFields;

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rollbackNewTask(store: TaskStore, id: number): string | null {
  try {
    if (store.removeTask(id)) return null;
    return "回滚未删除任务";
  } catch (e) {
    return `回滚异常:${reasonOf(e)}`;
  }
}

/**
 * Keys to restore after a forward `patch`: exactly the keys written, plus the columns `updateTask`
 * derives from them (a room change re-validates quality/engine; writing rollingUpload clears
 * rollingEffective). Derived from the patch itself, so a newly written field cannot escape rollback,
 * and fields this PUT never touched are never rewritten.
 */
export function rollbackKeys(patch: RecordingPatch): RecordingKey[] {
  const keys = new Set(Object.keys(patch) as RecordingKey[]);
  if (keys.has("room")) { keys.add("quality"); keys.add("engine"); }
  if (keys.has("rollingUpload")) keys.add("rollingEffective");
  return [...keys];
}

/** 从 HubRuleDTO 里剥掉身份四元组(key/platform/roomSlug/room)——RoomDTO 顶层已有。 */
function stripIdentity(dto: RoomDTO["processing"] & { key?: string }): NonNullable<RoomDTO["processing"]> {
  const { key: _k, platform: _p, roomSlug: _r, room: _room, ...rest } = dto as Record<string, unknown>;
  void _k; void _p; void _r; void _room;
  return rest as NonNullable<RoomDTO["processing"]>;
}

export function buildRooms(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, err, normWebhook, toUseCookie,
    validateWorkers, validatePipeline, zeroDiskErrorFor } = ctx;

  /**
   * 普通节点没有 hub 编排:规则文件只属于 master。写在本机不会生效,只会留下一份
   * 「看起来配了处理、其实永不运行」的假配置。POST/PUT 共用这一句,文案同源。
   */
  const ruleWriteRefusal = (): ApiResult =>
    err(400, "本节点未启用 hub(master),房间的处理半边只能在主控配置");

  /**
   * 解析 `{platform}.{roomSlug}`;格式非法 → null(调用方回 400)。
   *
   * 只做**语法**校验,不校验平台是否已注册 —— key 里的 platform 只是用来与
   * `platformForRoom(task.room).id` 做字符串比对的,不会驱动任何平台实现,
   * 所以未知平台只会「查不到房间 → 404」,不需要在这里拦。
   * (自审:第一版在这里写了个 `platformForRoom(douyin…)` 的空 try/catch 想「校验平台」,
   *  实际什么都没校验,纯误导,删掉。)
   */
  const parseKey = (key: string): { platform: string; roomSlug: string } | null => {
    const i = key.indexOf(".");
    if (i <= 0 || i === key.length - 1) return null;
    const platform = key.slice(0, i);
    const roomSlug = key.slice(i + 1);
    if (!platform || !roomSlug) return null;
    return { platform, roomSlug };
  };

  const secretsOf = (t: Task): Pick<RoomRecordingDTO, "cookies" | "webhook" | "hasCookies" | "hasWebhook"> => {
    const { cookies, webhook, hasCookies, hasWebhook } = redactTaskSecrets(t);
    return { cookies, webhook, hasCookies, hasWebhook };
  };

  const recordingOf = (t: Task | null): RoomRecordingDTO | null => {
    if (!t) return null;
    // 输出格式锁:与 TaskDTO(`web/api/context.ts` view)同一判定 `nodeOutputFormatLock`、同一口径。
    const lock = nodeOutputFormatLock(t, hubDir);
    return {
      ...(lock ? { outputFormatLock: lock } : {}),
      taskId: t.id,
      room: t.room,
      name: t.name,
      anchorName: t.anchorName,
      quality: t.quality,
      engine: t.engine,
      danmu: t.danmu,
      segmentSec: t.segmentSec,
      scheduleStart: t.scheduleStart,
      scheduleEnd: t.scheduleEnd,
      enabled: t.enabled,
      useCookie: t.useCookie,
      // cookies / webhook 是凭证:DTO 恒不外发(redactTaskSecrets 单一出口),要改用 PUT。
      ...secretsOf(t),
      outDir: t.outDir,
      rollingUpload: t.rollingUpload,
      rollingEffective: t.rollingEffective,
      streamUpload: t.streamUpload,
      streamUploadSpool: t.streamUploadSpool,
      outputFormat: t.outputFormat,
    };
  };

  /**
   * 找该房间的录制任务。**先按 sourceTaskId 精确找,再按 (platform, roomSlug) 反查** ——
   * 后者覆盖「任务先建好、还没绑到 hub 规则」的常见情况(前端加房间就是这个顺序)。
   */
  const findTask = (platform: string, roomSlug: string, sourceTaskId: number | null): Task | null => {
    if (sourceTaskId) {
      const t = store.getTask(sourceTaskId);
      if (t) {
        const p = platformForRoom(t.room);
        if (p.id === platform && p.extractRoomSlug(t.room) === roomSlug) return t;
      }
    }
    return (
      store.listTasks().find((t) => {
        try {
          const p = platformForRoom(t.room);
          return p.id === platform && p.extractRoomSlug(t.room) === roomSlug;
        } catch {
          return false;
        }
      }) ?? null
    );
  };

  const view = (key: string): RoomDTO | null => {
    const k = parseKey(key);
    if (!k) return null;
    const rule = hubStore.listHubRules(hubDir).find((r) => r.key === key) ?? null;
    const task = findTask(k.platform, k.roomSlug, rule?.recording?.sourceTaskId ?? null);
    const room = rule?.room || task?.room || "";
    // 没有规则 → processing 必须是 null(而不是一个 enabled:false 的空壳),
    // 否则前端分不清「配了处理但停用」和「根本没配处理」。
    // 自审:第一版为了拿 processing 字段,给无规则的情况**造了个假 rule** 传进 hubRuleView,
    // 那条路径会顺手触发 anchorName 反查等无意义工作,且读起来像「有规则」——已改成只读真规则。
    const processing = rule ? stripIdentity(ctx.hubRuleView(rule)) : null;
    return {
      key,
      platform: k.platform,
      roomSlug: k.roomSlug,
      room,
      recording: recordingOf(task),
      processing: rule ? processing : null,
    };
  };

  return {
    /** GET /api/rooms —— 全部房间(有规则的 + 有录制任务的),供「一个房间一个入口」列表用。 */
    listRooms(): ApiResult {
      const keys = new Set<string>();
      for (const r of hubStore.listHubRules(hubDir)) keys.add(r.key);
      for (const t of store.listTasks()) {
        try {
          const p = platformForRoom(t.room);
          keys.add(`${p.id}.${p.extractRoomSlug(t.room)}`);
        } catch {
          /* 房间地址异常的任务不进房间列表(与旧接口一致:该任务自己仍可在 /api/tasks 看到) */
        }
      }
      const rooms = [...keys].map(view).filter((r): r is RoomDTO => r !== null);
      return { status: 200, body: rooms };
    },

    /** GET /api/rooms/:key —— 录制 + 处理两半合并视图。 */
    getRoom(key: string): ApiResult {
      const k = parseKey(key);
      if (!k) return err(400, `房间 key 非法: ${key}(应为 {platform}.{roomSlug})`);
      const dto = view(key);
      // 两半都没有 = 这个房间不存在(而不是「存在但都空」——那没有意义)。
      if (!dto || (!dto.recording && !dto.processing)) return err(404, `未找到房间 ${key}`);
      return { status: 200, body: dto };
    },

    /**
     * POST /api/rooms —— **新建一个房间**:一次写两半(录制任务 + 处理规则)。
     *
     * 为什么需要它:此前「加房间」= 先 POST /api/tasks 再 POST /api/hub/rules —— 两步之间失败会留下
     * 「任务建了、规则没绑」的半成功,前端还得靠读列表反查 key 才补得上。
     *
     * 顺序:解析房间 → 重复检测 → 校验 processing(与 PUT 同一套单点) → addTask(默认停用)
     * → (master 且给了 processing)写规则 → 写失败回滚(删掉刚建的任务)。
     * 回滚本身失败必须**明说任务可能已创建**(静默半成功不可接受,与 PUT 同口径)。
     *
     * 普通节点(未启用 hub)拒绝 processing:节点上写的规则永不生效(见 ruleWriteRefusal)。
     * 只建录制半边时返回的 `processing` 恒为 null —— 前端据此知道「本节点没有处理配置」。
     */
    createRoom(input: CreateRoomInput): ApiResult {
      const room = (input.recording?.room ?? "").trim();
      if (!room) return err(400, "recording.room 必填(新建房间必须能判定平台与房间号)");
      const proc = input.processing;
      // 闸门必须在**任何写操作之前**:节点上带了 processing 就是一次注定无效的写。
      if (proc && deps.hubEnabled !== true) return ruleWriteRefusal();

      // 平台/房间解析失败 = 房间地址非法 → 400,不要冒成 500。
      let platform: ReturnType<typeof platformForRoom>;
      let roomSlug: string;
      try {
        platform = platformForRoom(room);
        roomSlug = platform.extractRoomSlug(room);
      } catch (e) {
        return err(400, `房间地址非法:${(e as Error).message}`);
      }
      if (!roomSlug) return err(400, `房间地址非法,取不到房间号: ${room}`);
      const key = hubStore.hubKey(platform.id, roomSlug);

      // 一个房间只有一条录制半边:同 (platform, roomSlug) 已有任务 → 409(与 findTask/view 同口径,
      // 裸房间号与规范 URL 经 normalizeRoom 后撞在一起)。
      const dup = findTask(platform.id, roomSlug, null);
      if (dup) return err(409, `该房间已有录制任务(id=${dup.id}),请直接编辑它而不是新建`);

      const rec = input.recording;

      // ── 录制半边的输入归一化(全部复用唯一真理源,不写第二套) ──────────────────
      // schedule 是**两个字段**:只给一端会造出半个窗口 → 400,而不是静默存坏。
      let scheduleStart: string | null = null;
      let scheduleEnd: string | null = null;
      {
        const s = rec.scheduleStart ?? null;
        const e = rec.scheduleEnd ?? null;
        const empty = (v: string | null): boolean => v == null || v.trim() === "";
        if (empty(s) !== empty(e)) return err(400, "定时窗口的起止需同时填写或同时留空");
        if (s != null && e != null && !empty(s) && !empty(e)) {
          try {
            [scheduleStart, scheduleEnd] = parseSchedule(`${s}-${e}`);
          } catch (e2) {
            return err(400, (e2 as Error).message);
          }
        }
      }
      // 互斥(单一判定 = core.streamUploadConflicts):直播直传不写盘,滚动上传靠文件。
      if (streamUploadConflicts(rec.streamUpload === true, rec.rollingUpload === true)) {
        return err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件");
      }
      let outputFormat: ReturnType<typeof parseOutputFormat>;
      try { outputFormat = parseOutputFormat(rec.outputFormat); } catch (e) { return err(400, (e as Error).message); }

      // ── 处理半边:校验在写之前(与 PUT 同一套:workers / pipeline) ────────────
      // 房间可能已有「只有规则、没有任务」的残留(旧路径留下的),create 是 upsert:
      // pipeline 校验要对**合并后**的结果做,不能只看本次请求。
      const existingRule = hubStore.getHubRule(hubDir, key);
      if (proc) {
        const checkInput: HubRulePayload = {
          enabled: proc.enabled,
          pipeline: proc.pipeline,
          workers: proc.workers === null ? undefined : proc.workers,
          requires: proc.requires,
        };
        const werr = validateWorkers(checkInput);
        if (werr) return err(400, werr);
        const perr = validatePipeline(checkInput, existingRule?.pipeline);
        if (perr) return err(400, perr);
      }

      // ── 录制任务:不传 enabled → store 默认 false(创建即暂停,需手动开启) ──────
      let task: Task;
      try {
        task = store.addTask({
          room,
          name: rec.name ?? null,
          quality: rec.quality,
          engine: rec.engine, // store 按 platform.engines 校验/回落
          danmu: toDanmuFlag(rec.danmu),
          segmentSec: rec.segmentSec,
          cookies: rec.cookies ?? null,
          useCookie: toUseCookie(rec.useCookie),
          outDir: rec.outDir ?? null,
          scheduleStart,
          scheduleEnd,
          webhook: normWebhook(rec.webhook),
          rollingUpload: rec.rollingUpload === true,
          streamUpload: rec.streamUpload === true,
          streamUploadSpool: rec.streamUploadSpool !== false,
          outputFormat,
        });
      } catch (e) {
        return err(400, `创建录制任务失败:${(e as Error).message}`);
      }

      // 直播直传是 rolling 的子模式,且 zeroDiskErrorFor 要求有真实的 source task →
      // 这一步只能在 addTask 之后判;判失败就删掉刚建的任务(不留半成功)。
      // 无规则且本次没给 processing 时传 null(= 与 createTask 同口径,允许先建任务后配规则)。
      const merged = hubStore.mergePipeline(existingRule?.pipeline, proc?.pipeline);
      const zeroErr = zeroDiskErrorFor(
        task.id,
        rec.streamUpload === true,
        (existingRule || proc)
          ? {
              enabled: proc?.enabled ?? existingRule?.enabled ?? true,
              // 新建规则未显式给 mode = 按默认 upload 判(与 PUT 的 `?? "upload"` 同口径)。
              mode: merged.upload?.mode ?? "upload",
              workers: proc?.workers === null ? [] : proc?.workers ?? existingRule?.workers,
              steps: merged.steps,
            }
          : null,
      );
      if (zeroErr) {
        const rollbackError = rollbackNewTask(store, task.id);
        if (rollbackError !== null) {
          return err(500, `${zeroErr};**且刚建的任务未能回滚(${rollbackError})** —— 房间 ${key} 的任务可能已创建(id=${task.id}),请手工核对`);
        }
        return err(400, zeroErr);
      }

      // ── 处理半边:写规则(sourceTaskId 指向刚建的任务) ────────────────────────
      if (proc) {
        try {
          hubStore.upsertHubRule(hubDir, {
            platform: platform.id,
            roomSlug,
            room: task.room,
            enabled: proc.enabled,
            pipeline: proc.pipeline,
            workers: proc.workers,
            requires: proc.requires,
            recording: { sourceTaskId: task.id },
          });
        } catch (e) {
          // 回滚第一步:本端点的核心承诺是不留半成功。回滚也失败就必须**明说**。
          const rollbackError = rollbackNewTask(store, task.id);
          if (rollbackError !== null) {
            return err(500, `写入处理配置失败(${reasonOf(e)});**且新建的录制任务未能回滚(${rollbackError})** —— 房间 ${key} 的任务可能已创建(id=${task.id}),请手工核对`);
          }
          return err(500, `写入处理配置失败(${reasonOf(e)}),已回滚新建的录制任务`);
        }
        refreshLocalRollingEffective(store, hubDir); // 新规则的派生值立刻生效
      }

      // 创建即抓主播名(不等开始录制);后台写回,UI 轮询即显示。
      ctx.resolveAnchorBg(task.id, task.room);
      // 新建的规则要立刻下发,不等 60s 周期 tick(节点未注入该依赖时是无害 no-op)。
      deps.requestSyncTasks?.();

      const after = view(key);
      if (!after) return err(500, "房间创建后读不回来(store/hub 目录不一致?)");
      return { status: 201, body: after };
    },

    /**
     * PUT /api/rooms/:key —— 一次改两半(各自可选)。
     *
     * 顺序:校验 → 写 task → 写规则 → (规则失败则回滚 task)。
     * 「两半都没传」按 400 拒:那是一次无意义的写,静默成功会掩盖前端 bug。
     */
    updateRoom(key: string, input: RoomPayload): ApiResult {
      const k = parseKey(key);
      if (!k) return err(400, `房间 key 非法: ${key}(应为 {platform}.{roomSlug})`);
      if (input.recording === undefined && input.processing === undefined) {
        return err(400, "recording 与 processing 至少传一个");
      }

      const before = view(key);
      if (!before) return err(404, `未找到房间 ${key}`);
      const proc = input.processing;
      // 普通节点不得写规则文件(与 POST 同一闸门):校验在任何写之前,避免留下无效的本地规则。
      if (proc && deps.hubEnabled !== true) return ruleWriteRefusal();

      const recInput = input.recording;
      const existingStreamUpload = before.recording?.streamUpload === true;
      const streamUploadNext = recInput && "streamUpload" in recInput
        ? recInput.streamUpload === true
        : existingStreamUpload;
      // The editor sends `streamUpload:false` when it leaves rolling. A partial API write that
      // only changes the mode still has to be rejected, not silently reinterpreted.
      const zeroDiskNext = streamUploadNext;
      // A room change moves the task to a different rule key. Validate zero-disk against the
      // rule the task will actually live under, not the old key this request was addressed to.
      const nextRoom = (recInput?.room ?? before.room).trim() || before.room;
      const nextP = platformForRoom(nextRoom);
      const nextKey = hubStore.hubKey(nextP.id, nextP.extractRoomSlug(nextRoom));
      const sameKey = nextKey === key;
      // Saving a zero-disk room must also be a rolling rule with no burn, pinned to exactly one node.
      // Check it before the recording write so a rejected rule leaves the task untouched.
      const nextRule = hubStore.getHubRule(hubDir, nextKey);
      const mergedPipeline = hubStore.mergePipeline(
        nextRule?.pipeline,
        sameKey ? input.processing?.pipeline : undefined,
      );
      // When the room changes, the incoming processing patch belongs to the old key and must
      // not be used: validate against the rule that already exists at the destination.
      const nextEnabled = (sameKey ? input.processing?.enabled : undefined) ?? nextRule?.enabled ?? before.processing?.enabled ?? true;
      const nextWorkers = sameKey
        ? input.processing?.workers === null ? [] : input.processing?.workers ?? nextRule?.workers
        : nextRule?.workers;
      // No rule exists before or after this save → zero-disk needs no rule validation
      // (same reading as createRoom); a stale streamUpload task can still be renamed.
      const hasRuleAfter = Boolean(nextRule || proc || before.processing);
      const zeroErr = ctx.zeroDiskErrorFor(
        before.recording?.taskId ?? null,
        zeroDiskNext,
        hasRuleAfter ? {
          enabled: nextEnabled,
          // A rule without an explicit mode is read as the upload-mode default (same as
          // createRoom); don't claim it is rolling.
          mode: mergedPipeline.upload?.mode ?? (nextRule || before.processing ? "upload" : undefined),
          workers: nextWorkers,
          steps: mergedPipeline.steps,
        } : null,
      );
      if (zeroErr) return err(400, zeroErr);
      if (proc && sameKey) {
        // The rule side must be valid for every zero-disk task in the room, not only the source
        // task that the rule happens to point at.
        const roomErr = ctx.zeroDiskRoomError(
          k.platform,
          k.roomSlug,
          {
            enabled: proc.enabled ?? before.processing?.enabled ?? true,
            mode: mergedPipeline.upload?.mode,
            workers: proc.workers === null ? [] : proc.workers ?? before.processing?.workers,
            steps: mergedPipeline.steps,
          },
          { taskId: before.recording?.taskId ?? null, streamUpload: zeroDiskNext },
        );
        if (roomErr) return err(400, roomErr);
      }

      // Validate the processing half BEFORE touching the task: a rejection after the recording write
      // would leave a half-applied save behind an error toast (the rollback below only covers a failed
      // rule write). `workers: null` = explicit "all nodes" (clears the restriction); `[]` stays invalid.
      if (proc) {
        const checkInput: HubRulePayload = {
          enabled: proc.enabled,
          pipeline: proc.pipeline,
          workers: proc.workers === null ? undefined : proc.workers,
          requires: proc.requires,
        };
        const werr = ctx.validateWorkers(checkInput);
        if (werr) return err(400, werr);
        const perr = ctx.validatePipeline(checkInput, hubStore.getHubRule(hubDir, key)?.pipeline);
        if (perr) return err(400, perr);
      }

      // ── 录制半边 ──────────────────────────────────────────────────────────────
      const rec = input.recording;
      let taskId = before.recording?.taskId ?? null;
      // Raw pre-write snapshot (the DTO hides cookies) + the keys to undo; set once the recording half is written.
      let snapshot: Task | null = null;
      let undoKeys: RecordingKey[] = [];
      /** Undo the recording write; returns false when the undo itself failed. */
      const rollbackRecording = (): boolean => {
        if (!snapshot || taskId === null) return true;
        const prev: Record<string, unknown> = {};
        // A NULL rollingEffective reads as its derived value, so it comes back as an explicit 0/1 that
        // reads the same; the next refreshLocalRollingEffective pass restores NULL where applicable.
        for (const f of undoKeys) prev[f] = snapshot[f];
        try {
          return store.updateTask(taskId, prev as RecordingPatch) !== null;
        } catch {
          return false;
        }
      };
      const failAfterRecording = (status: number, reason: string): ApiResult => {
        if (!snapshot) return err(status, reason);
        if (!rollbackRecording()) {
          return err(500, `${reason};**且录制配置的回滚也失败了** —— 该房间 ${key} 的录制半边可能已被改动,请手工核对`);
        }
        return err(status, `${reason},已回滚录制配置`);
      };
      if (rec) {
        const patch: Parameters<typeof store.updateTask>[1] = {};
        if ("room" in rec) {
          const room = (rec.room ?? "").trim();
          if (!room) return err(400, "recording.room 不能为空");
          patch.room = room;
        }
        if ("name" in rec) patch.name = rec.name ?? null;
        if ("quality" in rec) patch.quality = rec.quality;
        if ("engine" in rec) patch.engine = rec.engine;
        // 归一化复用 task-input 的权威实现(自审:第一版我自己写了 `rec.danmu ? 1 : 0`,
        // 与 tasks.ts 的 toDanmuFlag 成了第二套 —— undefined 语义会不一致)。
        if ("danmu" in rec) patch.danmu = toDanmuFlag(rec.danmu);
        if ("segmentSec" in rec) patch.segmentSec = rec.segmentSec;
        // schedule:RoomPayload 是 Partial<RoomRecordingDTO>,窗口是**两个字段**(scheduleStart/End)。
        // 单独改一个端点会造出半个窗口 —— 必须成对,否则 400 让用户看到,而不是静默存坏。
        // (自审发现:此前这里根本没有 schedule,前端表单改窗口提交后**静默丢失**。)
        const hasSchedStart = "scheduleStart" in rec;
        const hasSchedEnd = "scheduleEnd" in rec;
        if (hasSchedStart !== hasSchedEnd) {
          return err(400, "定时窗口需同时提供 scheduleStart 与 scheduleEnd(或都传 null 清空)");
        }
        if (hasSchedStart && hasSchedEnd) {
          const s = rec.scheduleStart;
          const e = rec.scheduleEnd;
          const empty = (v: string | null | undefined): boolean => v == null || v.trim() === "";
          if (empty(s) && empty(e)) {
            patch.scheduleStart = null;
            patch.scheduleEnd = null;
          } else if (empty(s) !== empty(e)) {
            return err(400, "定时窗口的起止需同时填写或同时留空");
          } else {
            // 格式校验复用唯一真理 parseSchedule(/api/tasks 用的同一份),不自己再写一套正则
            // —— 两套迟早漂移(某处放宽了另一处没跟)。
            try {
              const [ss, ee] = parseSchedule(`${s}-${e}`);
              patch.scheduleStart = ss;
              patch.scheduleEnd = ee;
            } catch (err2) {
              return err(400, (err2 as Error).message);
            }
          }
        }
        if ("useCookie" in rec) patch.useCookie = ctx.toUseCookie(rec.useCookie);
        if ("cookies" in rec) patch.cookies = rec.cookies ?? null;
        if ("outDir" in rec) patch.outDir = rec.outDir ?? null;
        if ("webhook" in rec) patch.webhook = normWebhook(rec.webhook);
        if ("rollingUpload" in rec) patch.rollingUpload = rec.rollingUpload === true;
        if ("streamUpload" in rec) patch.streamUpload = rec.streamUpload === true;
        if ("streamUploadSpool" in rec) patch.streamUploadSpool = rec.streamUploadSpool !== false;
        // 互斥(单一判定 = core.streamUploadConflicts):用 patch 后生效值比,只改一边也挡另一边的存量。
        if (streamUploadConflicts(
          patch.streamUpload ?? before.recording?.streamUpload,
          patch.rollingUpload ?? before.recording?.rollingUpload,
        )) {
          return err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件");
        }
        if ("outputFormat" in rec) {
          try { patch.outputFormat = parseOutputFormat(rec.outputFormat); } catch (e) { return err(400, (e as Error).message); }
        }

        if (taskId === null) {
          // 没有任务可改:要么忽略(只改处理),要么 400 让用户知道得先建任务。
          // 静默忽略 = 「我以为改了画质其实没改」,是最坏的一种。
          const hasRealField = Object.keys(patch).some((key2) => key2 !== "webhook");
          if (hasRealField) return err(400, "该房间还没有绑定录制任务,请先创建任务再改录制配置");
        } else {
          const t = store.getTask(taskId);
          if (!t) return err(404, `房间 ${key} 绑定的录制任务已不存在(id=${taskId})`);
          if (t.managedBy === "hub") return err(403, `任务 id=${taskId} 由 hub 管理,请在 master 上修改`);
          const updated = store.updateTask(taskId, patch);
          if (!updated) return err(500, `写入录制配置失败(id=${taskId})`);
          snapshot = t;
          undoKeys = rollbackKeys(patch);
        }
      }

      // ── 处理半边 ──────────────────────────────────────────────────────────────
      if (proc) {
        // 「要改 processing 但没有 sourceTaskId」→ 规则建了也没法下发,必须让用户补。
        const sourceTaskId = before.processing
          ? ((before.processing as { recording?: { sourceTaskId?: number | null } }).recording?.sourceTaskId ?? taskId)
          : taskId;
        // Checked after the recording write on purpose: it must see a room change made by this PUT.
        // A failure here rolls the recording half back like a failed rule write (#200).
        // A zero-disk source may be bound when this same write creates its rolling rule;
        // zeroDiskErrorFor above has already rejected non-rolling / burning / multi-node.
        const rerr = ctx.recordingError(
          sourceTaskId,
          k.roomSlug,
          zeroDiskNext && sourceTaskId ? { recording: { sourceTaskId } } : hubStore.getHubRule(hubDir, key),
        );
        if (rerr) return failAfterRecording(400, rerr);

        try {
          hubStore.upsertHubRule(hubDir, {
            platform: k.platform,
            roomSlug: k.roomSlug,
            room: before.room,
            enabled: proc.enabled,
            pipeline: proc.pipeline,
            workers: proc.workers,
            requires: proc.requires,
            recording: sourceTaskId ? { sourceTaskId } : undefined,
          });
        } catch (e) {
          // 回滚第一步:不留半成功。这是本域存在的核心原因。
          return failAfterRecording(500, `写入处理配置失败(${(e as Error).message})`);
        }
        // 规则此前已存在(表单展示的是读取时迁移后的 mode)才收口旧开关;新建规则同 createHubRule 不收口。
        if (before.processing) ctx.settleLegacyRolling(sourceTaskId, proc.pipeline?.upload?.mode);
        refreshLocalRollingEffective(store, hubDir); // 停用/换 mode/解绑 → 本机派生值立刻重算
        // 处理半边变了 → 立刻下发一次(不等 60s 周期 tick)。
        deps.requestSyncTasks?.();
      } else if (rec) {
        // 只改了录制:若该任务是 hub 源任务,同样要立刻下发(T3:停用保留 ≠ 删除,靠这里生效)。
        if (taskId !== null && ctx.isHubSourceTask(taskId)) deps.requestSyncTasks?.();
      }

      const after = view(key);
      if (!after) return err(500, "写入后房间读不回来(store/hub 目录不一致?)");
      return { status: 200, body: after };
    },

    /**
     * DELETE /api/rooms/:key —— **删除整个房间**:录制任务 + hub 规则一起删。
     *
     * 为什么需要它:此前前端「删除房间」只调 `DELETE /api/tasks/:id`,hub 规则留在磁盘上;
     * 而列表数据源是「规则 ∪ 任务」,于是房间删完仍出现在 `/rooms`(只剩处理半边),
     * 且那个残留房间在房间页上**没有任何删除入口**(编辑器的删除按钮只在有 task 时出现)。
     * (Hub 页的「删除该 Hub 规则」是另一个显式入口,只删规则半边,语义不同,保持不变。)
     *
     * 守卫与两个旧端点一致:**先全部校验、再动数据**,任一不满足则两半都不动:
     *   - 受管任务(hub 远程副本)→ 403(只能在 master 上删);
     *   - 任务仍启用或正在录制 → 409(先停止);
     *   - 规则还有进行中的 hub job → 409(先等它结束或停止)。
     * 删除顺序:先删任务、再删规则与历史。后者失败时明确说明「任务已删、规则仍在」,
     * 不留静默半成功;此时重试本端点即可删掉剩下的规则半边。
     */
    deleteRoom(key: string): ApiResult {
      const k = parseKey(key);
      if (!k) return err(400, `房间 key 非法: ${key}(应为 {platform}.{roomSlug})`);
      const dto = view(key);
      if (!dto || (!dto.recording && !dto.processing)) return err(404, `未找到房间 ${key}`);

      // ── 先校验两半,任何一半不满足都不动数据 ──────────────────────────────
      const taskId = dto.recording?.taskId ?? null;
      const task = taskId !== null ? store.getTask(taskId) : null;
      if (task) {
        if (task.managedBy === "hub") return err(403, `任务 id=${task.id} 由 hub 管理，请在 master 上删除`);
        if (task.enabled || manager.isRunning(task.id)) {
          return err(409, `任务 id=${task.id} 仍启用或运行中，请先停止再删除房间`);
        }
      }
      const rule = hubStore.getHubRule(hubDir, key);
      if (rule && deps.syncDbPath) {
        const active = activeHubJobKeys(deps.syncDbPath, key);
        if (active.length > 0) {
          return err(409, `该直播间有进行中的 hub 任务(${active[0]}),请先等它结束或停止后再删除房间`);
        }
      }

      // ── 删除:先任务(守卫已过),再规则 + 历史 ────────────────────────────
      if (task && !store.removeTask(task.id)) {
        return err(500, `删除录制任务失败(id=${task.id}),房间未改动`);
      }
      let history = { deleted: 0 };
      if (rule && deps.syncDbPath) {
        // M1(review):删历史撞锁/出错会抛(#428 加的事务路径)。它在 removeTask 之后执行,
        // 异常若不接住会冒成通用 500,丢掉「任务已删、规则仍在」的显式说明 —— 那正是
        // 本端点承诺的不留静默半成功。接住后返回同一形态的 500,重试即可收敛。
        try {
          history = deleteHubJobHistory(deps.syncDbPath, key);
        } catch (e) {
          return err(500, `录制任务已删除,但处理历史清理失败(${(e as Error).message}) —— 规则仍在,请重试删除房间`);
        }
      }
      if (rule && !hubStore.removeHubRule(hubDir, key)) {
        // 任务已删、规则还在:房间会以「仅处理半边」继续出现,但重试本端点即可删掉它。
        return err(500, `录制任务已删除,但处理规则删除失败(${key}) —— 请重试删除房间`);
      }
      if (rule) {
        refreshLocalRollingEffective(store, hubDir); // 规则已删:本机源任务派生值回落
        deps.requestSyncTasks?.();
      }
      return { status: 200, body: { ok: true, key, deletedHistory: history.deleted } };
    },
  };
}
