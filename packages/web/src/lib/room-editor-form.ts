/**
 * room-editor-form.ts — `/rooms` editor state ↔ room payload (`POST /api/rooms` / `PUT /api/rooms/:key`).
 * Pure, tested.
 *
 * Field dependencies (locks, upload-method fallback, burn effective values) are NOT decided here —
 * they come from room-form-rules (shared with the Hub rule dialog). This file only maps.
 * Create and edit share the same mapping ({@link submitPayload}): the only differences are the
 * required `recording.room` (create) and the node role (`withProcessing`).
 */
import type { OutputFormat } from "@drec/output-format";
import type { CreateRoomInput, PlatformDTO, RoomDTO, RoomPayload } from "../api/client";
import { splitSchedule } from "./labels";
import {
  keepArchiveFromStored, methodFromStored, outputFormatFromStored, storedFromForm, type FormFacts, type UploadMethod,
} from "./room-form-rules";

export interface RoomForm {
  /**
   * 直播间地址。新建时是用户输入(必填);编辑时只是展示用的存量值 ——
   * payload **从不**回写它(存量写回会触发房间校验副作用)。
   */
  room: string;
  name: string;
  quality: string;
  engine: string;
  segmentSec: string;
  schedule: string;
  /** New webhook typed by the user. The stored value is never echoed to the client, so this starts empty. */
  webhook: string;
  /** A webhook is stored server-side (DTO `hasWebhook`). */
  hasWebhook: boolean;
  /** User asked to clear the stored webhook. */
  webhookClear: boolean;
  danmu: boolean;
  useCookie: boolean;
  procEnabled: boolean;
  uploadOn: boolean;
  method: UploadMethod;
  streamUpload: boolean;
  streamUploadSpool: boolean;
  mergeSegments: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  tsDirect: boolean;
  outputFormat: OutputFormat;
  uploadPrivate: boolean;
  tid: string;
  tag: string;
  desc: string;
  titleTemplate: string;
  submissionTitleTemplate: string;
  partTitleTemplate: string;
  seasonSectionId: string;
  /** Whether the stored rule already carries the key (including an explicit null). */
  seasonSectionIdStored: boolean;
  /** Live upload per-part size in MiB; empty = built-in default. */
  partSizeMiB: string;
  partSizeMiBStored: boolean;
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clKeepArchive: boolean;
  workers: string[];
  requires: string[];
}

/**
 * PATCH semantics for the per-task webhook secret: the server never returns the stored value, so
 * an untouched field must be OMITTED (= keep); typed text replaces; the explicit clear box sends null.
 */
export function webhookPatch(typed: string, clear: boolean): { webhook?: string | null } {
  const v = typed.trim();
  if (v) return { webhook: v };
  return clear ? { webhook: null } : {};
}

/** Prefilled when a room has no template of its own, so the shared title scheme is visible and editable. */
export const DEFAULT_TITLE_TEMPLATES = {
  titleTemplate: "{name}_{date}_{HH}-{mm}-{ss}",
  submissionTitleTemplate: "{name}_{date}_{title} 直播回放",
  partTitleTemplate: "P{part}",
} as const;

/** Empty clears/disables the association; otherwise the API accepts only a positive integer section id. */
export function isValidSeasonSectionIdInput(raw: string): boolean {
  const value = raw.trim();
  return value === "" || (/^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)));
}

/** Empty inherits when the key was never stored, clears when it exists, and parses a valid number otherwise. */
export function seasonSectionIdPatch(raw: string, stored: boolean): number | null | undefined {
  const value = raw.trim();
  if (!value) return stored ? null : undefined;
  return Number(value);
}

/** Invalid hidden leftovers are omitted so they neither persist nor clear an already stored association. */
export function seasonSectionIdPayload(raw: string, stored: boolean): number | null | undefined {
  return isValidSeasonSectionIdInput(raw) ? seasonSectionIdPatch(raw, stored) : undefined;
}

/** Mirrors the API range (core PART_SIZE_MIB_*); the web package does not depend on core. */
export const PART_SIZE_MIB_MIN = 100;
export const PART_SIZE_MIB_MAX = 4096;

/** Empty (default) or an integer inside the range the API accepts. */
export function isValidPartSizeInput(raw: string): boolean {
  const v = raw.trim();
  return v === "" || (/^\d+$/.test(v) && Number(v) >= PART_SIZE_MIB_MIN && Number(v) <= PART_SIZE_MIB_MAX);
}

/** Empty inherits when never stored, clears (null) when stored, otherwise the number; invalid input is omitted. */
export function partSizePayload(raw: string, stored: boolean): number | null | undefined {
  if (!isValidPartSizeInput(raw)) return undefined;
  const v = raw.trim();
  return v ? Number(v) : stored ? null : undefined;
}

export function formFromRoom(r: RoomDTO): RoomForm {
  const rec = r.recording;
  const p = r.processing?.pipeline ?? {};
  return {
    room: r.room,
    name: rec?.name ?? "",
    quality: rec?.quality ?? "",
    engine: rec?.engine ?? "",
    segmentSec: String(rec?.segmentSec ?? 1800),
    schedule: rec?.scheduleStart && rec?.scheduleEnd ? `${rec.scheduleStart}-${rec.scheduleEnd}` : "",
    webhook: "",
    hasWebhook: rec?.hasWebhook === true,
    webhookClear: false,
    danmu: !!rec?.danmu,
    useCookie: rec?.useCookie ?? true,
    procEnabled: r.processing?.enabled ?? true,
    ...methodFromStored(p.upload?.mode, p.steps?.nodeSideUpload === true),
    streamUpload: rec?.streamUpload === true,
    streamUploadSpool: rec?.streamUploadSpool !== false,
    // Burn defaults to ON (backend burnFlags reads `!== false`); `=== true` would silently save it off.
    mergeSegments: p.steps?.mergeSegments !== false,
    burnDanmu: p.steps?.burnDanmu !== false,
    burnLivechat: p.steps?.burnLivechat !== false,
    tsDirect: p.steps?.tsDirect === true,
    outputFormat: outputFormatFromStored(rec?.outputFormat),
    uploadPrivate: p.upload?.private !== false,
    tid: String(p.upload?.tid ?? 21),
    tag: p.upload?.tag ?? "",
    desc: p.upload?.desc ?? "",
    titleTemplate: p.upload?.titleTemplate || DEFAULT_TITLE_TEMPLATES.titleTemplate,
    submissionTitleTemplate: p.upload?.submissionTitleTemplate || DEFAULT_TITLE_TEMPLATES.submissionTitleTemplate,
    partTitleTemplate: p.upload?.partTitleTemplate || DEFAULT_TITLE_TEMPLATES.partTitleTemplate,
    seasonSectionId: p.upload?.seasonSectionId ? String(p.upload.seasonSectionId) : "",
    seasonSectionIdStored: !!p.upload && Object.prototype.hasOwnProperty.call(p.upload, "seasonSectionId"),
    partSizeMiB: p.upload?.partSizeMiB ? String(p.upload.partSizeMiB) : "",
    partSizeMiBStored: !!p.upload && Object.prototype.hasOwnProperty.call(p.upload, "partSizeMiB"),
    clStageSourceAfterMerge: p.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: p.cleanup?.sourceAfterDone === true,
    clKeepArchive: keepArchiveFromStored(p.cleanup?.stageAfterDone),
    workers: r.processing?.workers ?? [],
    requires: r.processing?.requires ?? [],
  };
}

/** Room facts the rules need beyond the form itself. */
export interface RoomContext {
  hasRecording: boolean;
  /** The room had a hub rule when the editor opened (not whether this save writes one). */
  hasRule: boolean;
  /** This save also writes the rule half (master). A worker never does, even if a stale local rule exists. */
  writesRule: boolean;
  danmuAvailable: boolean;
  cookieReady: boolean;
  cookieForStream: boolean;
}

export function factsOf(f: RoomForm, ctx: RoomContext): FormFacts {
  return {
    ...f,
    // No task yet: danmu is decided by the future task — must not lock burning with `false`.
    danmu: ctx.hasRecording ? f.danmu : true,
    danmuAvailable: ctx.danmuAvailable,
    cookieReady: ctx.cookieReady,
    cookieForStream: ctx.cookieForStream,
    hasRule: ctx.hasRule,
    streamUpload: f.streamUpload,
  };
}

/**
 * Facts for every decision that save will also make (locks, settled method, flow, stored values).
 * Saving always upserts the hub rule, so these assume the rule exists even for a task-only room;
 * display and save must share this one view or the editor would offer choices save then rewrites.
 * Only the VERSIONS visibility reads the real `ctx.hasRule` (via `factsOf`).
 */
export function ruleFactsOf(f: RoomForm, ctx: RoomContext): FormFacts {
  return factsOf(f, { ...ctx, hasRule: true });
}

export type PayloadError = "schedule" | "seasonSectionId" | "partSizeMiB" | "room";

export type PayloadResult = { ok: true; payload: RoomPayload } | { ok: false; error: Exclude<PayloadError, "room"> };

/**
 * Form → payload. `recording.enabled` is deliberately NOT sent: the list/detail switch owns it,
 * and an editor opened before a toggle must not write the stale value back.
 * `recording` is only sent when the room has a task (a rule-only room must not create one).
 */
export function payloadFromForm(f: RoomForm, ctx: RoomContext): PayloadResult {
  const sched = splitSchedule(f.schedule);
  if (!sched) return { ok: false, error: "schedule" };
  if (f.uploadOn && !isValidSeasonSectionIdInput(f.seasonSectionId)) return { ok: false, error: "seasonSectionId" };
  if (f.uploadOn && !isValidPartSizeInput(f.partSizeMiB)) return { ok: false, error: "partSizeMiB" };
  const stored = storedFromForm(ruleFactsOf(f, ctx));
  const trimOrUndef = (s: string): string | undefined => s.trim() || undefined;
  // Zero-disk fields are owned by the rule: write them only when this save writes the rule
  // and either it already exists or the new rolling mode needs the override. Otherwise omit
  // (PATCH = keep) so a task-only room keeps its stored value; leaving rolling still sends false.
  const writesZeroDisk = ctx.writesRule && (ctx.hasRule || stored.mode === "rolling");
  const zeroDisk = writesZeroDisk
    ? { streamUpload: stored.mode === "rolling" && f.streamUpload, streamUploadSpool: f.streamUploadSpool }
    : {};
  const recording: RoomPayload["recording"] = ctx.hasRecording
    ? {
        name: f.name.trim() || null,
        quality: f.quality,
        engine: f.engine,
        segmentSec: Number(f.segmentSec) || 1800,
        outputFormat: stored.outputFormat,
        danmu: f.danmu ? 1 : 0,
        useCookie: f.useCookie,
        ...zeroDisk,
        ...sched,
        ...webhookPatch(f.webhook, f.webhookClear),
      }
    : undefined;
  return {
    ok: true,
    payload: {
      ...(recording ? { recording } : {}),
      processing: {
        enabled: f.procEnabled,
        // Empty selection = all nodes. The API rejects `[]`, so say it explicitly with null (which also
        // clears an earlier restriction; omitting the field would silently keep it).
        workers: f.workers.length ? f.workers : null,
        requires: f.requires,
        pipeline: {
          steps: {
            mergeSegments: f.mergeSegments,
            burnDanmu: stored.burnDanmu,
            burnLivechat: stored.burnLivechat,
            nodeSideUpload: stored.nodeSideUpload,
            tsDirect: f.tsDirect,
          },
          cleanup: {
            stageSourceAfterMerge: f.clStageSourceAfterMerge,
            sourceAfterDone: f.clSourceAfterDone,
            stageAfterDone: stored.stageAfterDone,
          },
          upload: {
            mode: stored.mode,
            private: f.uploadPrivate,
            tag: trimOrUndef(f.tag),
            tid: Number(f.tid) || 21,
            desc: trimOrUndef(f.desc),
            titleTemplate: trimOrUndef(f.titleTemplate),
            submissionTitleTemplate: trimOrUndef(f.submissionTitleTemplate),
            partTitleTemplate: trimOrUndef(f.partTitleTemplate),
            seasonSectionId: seasonSectionIdPayload(f.seasonSectionId, f.seasonSectionIdStored),
            partSizeMiB: partSizePayload(f.partSizeMiB, f.partSizeMiBStored),
          },
        },
      },
    },
  };
}

/** 新建房间的「编辑空房间」基准:与 formFromRoom 同一份默认,避免第二套默认值漂移。 */
const EMPTY_ROOM: RoomDTO = { key: "", platform: "", roomSlug: "", room: "", recording: null, processing: null };

/**
 * 新增房间的表单初始值。除了 `room`(用户要填)与平台默认 quality/engine,其余都跟编辑空房间一致:
 * segmentSec 1800、useCookie 开、templates = {@link DEFAULT_TITLE_TEMPLATES}、tid 21、上传关(存档)。
 * `platform` 省略 = 平台未定(地址还没填)→ quality/engine 留空,待平台识别后再补默认。
 * 弹幕默认 **开**(与旧「添加房间」弹窗一致):建房间不开播,开了也不会多录什么。
 */
export function blankForm(platform?: Pick<PlatformDTO, "defaultQuality" | "defaultEngine">): RoomForm {
  return {
    ...formFromRoom(EMPTY_ROOM),
    room: "",
    danmu: true,
    quality: platform?.defaultQuality ?? "",
    engine: platform?.defaultEngine ?? "",
  };
}

/**
 * 提交结果。create = `POST /api/rooms`(两半一次写完,`recording.room` 必填);
 * edit = `PUT /api/rooms/:key`(不带 `room`,存量地址不回写)。
 */
export type SubmitResult =
  | { ok: true; mode: "create"; payload: CreateRoomInput }
  | { ok: true; mode: "edit"; payload: RoomPayload }
  | { ok: false; error: PayloadError };

/** 重载:调用点写死 mode,返回体才能不带联合(create 的 payload 才有 `recording.room`)。 */
export function submitPayload(
  f: RoomForm, ctx: RoomContext, o: { mode: "create"; withProcessing: boolean },
): { ok: true; mode: "create"; payload: CreateRoomInput } | { ok: false; error: PayloadError };
export function submitPayload(
  f: RoomForm, ctx: RoomContext, o: { mode: "edit"; withProcessing: boolean },
): { ok: true; mode: "edit"; payload: RoomPayload } | { ok: false; error: PayloadError };

/**
 * 新增与编辑**同一条**提交路径:同一套数值/排期校验({@link payloadFromForm})、同一份字段映射。
 * - `mode: "create"` → 多一个必填的 `recording.room`(后端用它判定平台与房间号)。
 * - `withProcessing: false`(worker:`nodeCaps().editPipeline === false`)→ 整段 `processing` 不发:
 *   规则只在主控生效,worker 上写它无用且后端直接 400。
 */
export function submitPayload(
  f: RoomForm,
  ctx: RoomContext,
  o: { mode: "create" | "edit"; withProcessing: boolean },
): SubmitResult {
  const base = payloadFromForm(f, ctx);
  if (!base.ok) return base;
  // `processing` 是 hub 规则字段:worker 上没有规则可写,整段省略(后端 PUT/POST 也会拒);
  // spread + undefined 仍会保留键,必须重建不含 processing 的对象。
  const payload: RoomPayload = o.withProcessing
    ? base.payload
    : (base.payload.recording ? { recording: base.payload.recording } : {});
  if (o.mode === "edit") return { ok: true, mode: "edit", payload };
  const room = f.room.trim();
  if (!room) return { ok: false, error: "room" };
  return { ok: true, mode: "create", payload: { ...payload, recording: { ...(payload.recording ?? {}), room } } };
}
