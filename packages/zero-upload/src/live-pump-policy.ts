import { CHUNK_UNIT } from "./live-pump-part-buffer.js";
import type { SealedPart, SegmentExit, SegmentRunResult } from "./live-pump-types.js";
export function alignFileSize(n: number): number {
  return n > 0 ? Math.ceil(n / CHUNK_UNIT) * CHUNK_UNIT : 0;
}
export const DEFAULT_SEGMENT_CAP = alignFileSize(1.5 * 1024 * 1024 * 1024);
export const DEFAULT_STALL_TIMEOUT_MS = 120000;
export const DEFAULT_MEDIA_WALL_ALERT_RATIO = 0.85;
export const RATIO_ALERT_COOLDOWN_MS = 30 * 60000;
export const ARCHIVE_PARTS_WARN_AT = 80;
export const DEFAULT_RECOVERY_WINDOW_MS = 20 * 60000;
export const MiB = 1024 * 1024;
export const MIN_PART_BYTES = 1024 * 1024;
export const NO_EXIT: SegmentExit = { code: null, signal: null, stderrTail: "" };
export function negligibleTail(part: SealedPart): boolean {
  if (!part.final || part.sink.spooledBytes >= MIN_PART_BYTES)
    return false;
  return !!part.timing && !(part.timing.durationSec > 0);
}
export const ZERO_DISK_PART_LOST = "上传跟不上录制且未保留本地 spool:该分 P 已丢失";
export function zeroDiskPartLost(spoolMode: "full" | "none" | undefined, backpressured: boolean | undefined): boolean {
  return (spoolMode ?? "full") === "none" && backpressured === true;
}
export function recoveryDeadlineAfterPart(sealedBy: SegmentRunResult["sealedBy"], nowMs: number, windowMs: number): number | undefined {
  return sealedBy === "stalled" ? nowMs + windowMs : undefined;
}
export const IDLE_POLL_MS = 30000;
export function estimateDuration(part: SealedPart): number {
  return part.timing && part.timing.durationSec > 0 ? part.timing.durationSec : Math.max(0.001, part.sealedMs / 1000);
}
