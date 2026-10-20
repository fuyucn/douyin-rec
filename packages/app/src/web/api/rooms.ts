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
import { parseOutputFormat, platformForRoom, streamUploadConflicts, type RoomDTO, type RoomPayload, type RoomRecordingDTO, type HubRulePayload } from "@drec/core";
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import * as hubStore from "../../hub-store.js";
import type { Task, TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";

type RecordingPatch = Parameters<TaskStore["updateTask"]>[1];
// Every writable key is a Task column, so a rollback can always read it from the snapshot.
type RecordingKey = keyof RecordingPatch & keyof Task;
const _patchKeysAreTaskFields: [Exclude<keyof RecordingPatch, keyof Task>] extends [never] ? true : never = true;
void _patchKeysAreTaskFields;

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
  const { deps, store, hubDir, err, normWebhook } = ctx;

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

  const recordingOf = (t: Task | null): RoomRecordingDTO | null =>
    t
      ? {
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
          // cookies 是敏感值:DTO 恒不外发。要改用 PUT。
          cookies: null,
          outDir: t.outDir,
          webhook: t.webhook,
          rollingUpload: t.rollingUpload,
          rollingEffective: t.rollingEffective,
          streamUpload: t.streamUpload,
          streamUploadSpool: t.streamUploadSpool,
          outputFormat: t.outputFormat,
        }
      : null;

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
      // Saving a zero-disk room must also be a rolling rule with no burn, pinned to local.
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
      const zeroErr = ctx.zeroDiskErrorFor(
        before.recording?.taskId ?? null,
        zeroDiskNext,
        {
          enabled: nextEnabled,
          // A room with no existing rule and no upload mode in this write is still a rule
          // being created with the upload-mode default; don't claim it is rolling.
          mode: mergedPipeline.upload?.mode ?? (nextRule || before.processing ? "upload" : undefined),
          workers: nextWorkers,
          steps: mergedPipeline.steps,
        },
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
          return err(400, "streamUpload 与 rollingUpload 互斥:0 落盘不写盘,滚动上传靠文件");
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
  };
}
