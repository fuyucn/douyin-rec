/**
 * room-editor-form.ts — `/rooms` editor state ↔ `PUT /api/rooms/:key` payload. Pure, tested.
 *
 * Field dependencies (locks, upload-method fallback, burn effective values) are NOT decided here —
 * they come from room-form-rules (shared with the Hub rule dialog). This file only maps.
 */
import type { OutputFormat } from "@drec/output-format";
import type { RoomDTO, RoomPayload } from "../api/client";
import { splitSchedule } from "./labels";
import {
  keepArchiveFromStored, methodFromStored, outputFormatFromStored, storedFromForm, type FormFacts, type UploadMethod,
} from "./room-form-rules";

export interface RoomForm {
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

/**
 * Turning upload off hides the season field, so an invalid leftover value would block save with no
 * visible cause. Drop only invalid values; a valid id is kept for the next time upload is enabled.
 */
export function seasonSectionIdOnUploadToggle(current: string, uploadOn: boolean): string {
  if (uploadOn || isValidSeasonSectionIdInput(current)) return current;
  return "";
}

export function formFromRoom(r: RoomDTO): RoomForm {
  const rec = r.recording;
  const p = r.processing?.pipeline ?? {};
  return {
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
  /** The room already has a hub rule. A task-only room has none, so nothing can burn there. */
  hasRule: boolean;
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

export type PayloadResult = { ok: true; payload: RoomPayload } | { ok: false; error: "schedule" | "seasonSectionId" };

/**
 * Form → payload. `recording.enabled` is deliberately NOT sent: the list/detail switch owns it,
 * and an editor opened before a toggle must not write the stale value back.
 * `recording` is only sent when the room has a task (a rule-only room must not create one).
 */
export function payloadFromForm(f: RoomForm, ctx: RoomContext): PayloadResult {
  const sched = splitSchedule(f.schedule);
  if (!sched) return { ok: false, error: "schedule" };
  if (!isValidSeasonSectionIdInput(f.seasonSectionId)) return { ok: false, error: "seasonSectionId" };
  const stored = storedFromForm(ruleFactsOf(f, ctx));
  const trimOrUndef = (s: string): string | undefined => s.trim() || undefined;
  const recording: RoomPayload["recording"] = ctx.hasRecording
    ? {
        name: f.name.trim() || null,
        quality: f.quality,
        engine: f.engine,
        segmentSec: Number(f.segmentSec) || 1800,
        outputFormat: stored.outputFormat,
        danmu: f.danmu ? 1 : 0,
        useCookie: f.useCookie,
        // Zero-disk is only meaningful under rolling; other modes clear it so a later save
        // cannot resurrect a hidden switch.
        streamUpload: stored.mode === "rolling" && f.streamUpload,
        streamUploadSpool: f.streamUploadSpool,
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
            seasonSectionId: seasonSectionIdPatch(f.seasonSectionId, f.seasonSectionIdStored),
          },
        },
      },
    },
  };
}
