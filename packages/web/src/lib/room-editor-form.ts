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
  webhook: string;
  danmu: boolean;
  useCookie: boolean;
  procEnabled: boolean;
  uploadOn: boolean;
  method: UploadMethod;
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
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clKeepArchive: boolean;
  workers: string[];
  requires: string[];
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
    webhook: rec?.webhook ?? "",
    danmu: !!rec?.danmu,
    useCookie: rec?.useCookie ?? true,
    procEnabled: r.processing?.enabled ?? true,
    ...methodFromStored(p.upload?.mode, p.steps?.nodeSideUpload === true),
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
    titleTemplate: p.upload?.titleTemplate ?? "",
    submissionTitleTemplate: p.upload?.submissionTitleTemplate ?? "",
    partTitleTemplate: p.upload?.partTitleTemplate ?? "",
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
    // Saving always upserts the hub rule through the rooms API (empty workers = all nodes).
    hasRule: true,
  };
}

export type PayloadResult = { ok: true; payload: RoomPayload } | { ok: false; error: "schedule" };

/**
 * Form → payload. `recording.enabled` is deliberately NOT sent: the list/detail switch owns it,
 * and an editor opened before a toggle must not write the stale value back.
 * `recording` is only sent when the room has a task (a rule-only room must not create one).
 */
export function payloadFromForm(f: RoomForm, ctx: RoomContext): PayloadResult {
  const sched = splitSchedule(f.schedule);
  if (!sched) return { ok: false, error: "schedule" };
  const stored = storedFromForm(factsOf(f, ctx));
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
        ...sched,
        webhook: f.webhook.trim() || null,
      }
    : undefined;
  return {
    ok: true,
    payload: {
      ...(recording ? { recording } : {}),
      processing: {
        enabled: f.procEnabled,
        workers: f.workers,
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
          },
        },
      },
    },
  };
}
