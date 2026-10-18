// packages/orchestrator/src/unclaimed.ts
// Detection of converted (mp4/mkv) segments that groupSessions does not claim. Pure helpers only;
// the filesystem pass lives in scan.ts.
import { isAtomicTempName, segmentIndexOf, STAGE_EXTS, stampedSessionBaseOf } from "@drec/core";
import { isSplitPartName } from "@drec/post-process";

export type SidecarShape = "missing" | "unparsable" | "minimal" | "full";

export interface UnclaimedSegment {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  sessionBase: string;
  segmentIndex: number;
  /** Recording start epoch ms; null when neither the sidecar nor the filename yields one. */
  stampMs: number | null;
  stampSource: "sidecar" | "filename" | null;
  sidecar: SidecarShape;
  platform: string | null;
  roomSlug: string | null;
  /** Configured segment length of the anchor's task; null when unknown. */
  segmentSec: number | null;
}

/** Max orphan segments reported per scan; the rest are counted in `unclaimedTruncated`. */
export const UNCLAIMED_CAP = 200;

/**
 * Stamped + indexed mp4/mkv file names that are not in `claimed`. Native containers, atomic temps,
 * runner/suspect intermediates, split parts and unstamped/unindexed products never match.
 */
export function classifyUnclaimedFiles(
  files: readonly string[],
  claimed: ReadonlySet<string>,
): Array<{ file: string; sessionBase: string; segmentIndex: number }> {
  const out: Array<{ file: string; sessionBase: string; segmentIndex: number }> = [];
  for (const file of files) {
    if (isAtomicTempName(file)) continue;
    if (!STAGE_EXTS.some((ext) => file.toLowerCase().endsWith(ext))) continue;
    if (isSplitPartName(file) || claimed.has(file)) continue;
    const sessionBase = stampedSessionBaseOf(file);
    const segmentIndex = segmentIndexOf(file);
    if (sessionBase === undefined || segmentIndex < 0) continue;
    out.push({ file, sessionBase, segmentIndex });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The room shared by every sibling sidecar; null when there are none or they disagree. */
export function inferRoomFromSiblings(
  siblings: ReadonlyArray<{ platform?: string; roomSlug?: string }>,
): { platform: string; roomSlug: string } | null {
  const first = siblings[0];
  if (!first?.platform || !first.roomSlug) return null;
  const { platform, roomSlug } = first;
  return siblings.every((s) => s.platform === platform && s.roomSlug === roomSlug) ? { platform, roomSlug } : null;
}
