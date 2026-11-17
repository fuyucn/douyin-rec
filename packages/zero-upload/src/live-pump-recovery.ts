import { findArchiveByTitle, lookupArchive } from "./upos-stream.js";
import type { LivePumpState } from "./live-pump-state.js";

export interface RecoveryResult {
  ok: boolean;
  reason?: string;
  archiveExists?: boolean;
  needsManual?: boolean;
}

type ArchiveIdentity = Readonly<Pick<LivePumpState, "title" | "bvid" | "aid">>;
type PendingPublication = Readonly<Pick<NonNullable<LivePumpState["pending"]>, "kind" | "stem">>;
type RecoveryOptions = {
  pending: PendingPublication;
  archive: ArchiveIdentity;
  cookiesPath: string;
  fetchImpl?: typeof fetch;
};

type RecoveryOutcome =
  | { kind: "not-created" }
  | { kind: "created"; bvid?: string; aid?: number }
  | { kind: "existing"; bvid?: string; aid: number; confirmed: boolean }
  | { kind: "blocked"; result: RecoveryResult };

/** Query only: the caller retains every pending row, durable write and cleanup decision. */
export async function resolveInterruptedPublication(o: RecoveryOptions): Promise<RecoveryOutcome> {
  const identity = o.archive;
  if (o.pending.kind === "create" && !identity.bvid && !identity.aid) {
    return resolveCreatedPublication(o, identity.title);
  }
  if (!identity.bvid && !identity.aid) {
    return { kind: "blocked", result: { ok: false, reason: "pending append without archive identity" } };
  }
  let found;
  try {
    found = await lookupArchive({
      cookiesPath: o.cookiesPath,
      ...(identity.bvid ? { bvid: identity.bvid } : { aid: identity.aid }),
      fetchImpl: o.fetchImpl ?? fetch,
    });
  } catch (e) {
    return { kind: "blocked", result: { ok: false,
      reason: "cannot read archive during recovery: " + String((e as Error)?.message ?? e).slice(0, 200) } };
  }
  if (!found.ok || !found.archive) {
    return { kind: "blocked", result: { ok: false, reason: "cannot read archive during recovery" } };
  }
  return { kind: "existing", bvid: found.archive.bvid, aid: found.archive.aid,
    confirmed: found.archive.videos.some((video) => video.filename === o.pending.stem) };
}

/** Only a readable, empty exact-title search proves that the create request did not happen. */
async function resolveCreatedPublication(o: RecoveryOptions, title: string): Promise<RecoveryOutcome> {
  let found;
  try {
    found = await findArchiveByTitle({ cookiesPath: o.cookiesPath, title, fetchImpl: o.fetchImpl ?? fetch });
  } catch (e) {
    return { kind: "blocked", result: { ok: false,
      reason: "cannot search archive during recovery: " + String((e as Error)?.message ?? e).slice(0, 200) } };
  }
  if (found.searched === false) {
    return { kind: "blocked", result: { ok: false, needsManual: true,
      reason: "cannot search archive during recovery; needs manual verification" } };
  }
  if (found.searched === true && found.matches === 0) return { kind: "not-created" };
  if (!found.ok || !found.archive) {
    return { kind: "blocked", result: { ok: false, needsManual: true,
      reason: "create outcome ambiguous (matches=" + found.matches + "); needs manual verification" } };
  }
  if (!found.archive.videos.some((video) => video.filename === o.pending.stem)) {
    return { kind: "blocked", result: { ok: false, archiveExists: true, needsManual: true,
      reason: "archive found but first part is not present; needs manual verification" } };
  }
  if (!found.archive.bvid && !(found.archive.aid > 0)) {
    return { kind: "blocked", result: { ok: false, archiveExists: true, needsManual: true,
      reason: "archive found but has no bvid/aid; needs manual verification" } };
  }
  return { kind: "created",
    ...(found.archive.bvid ? { bvid: found.archive.bvid } : {}),
    ...(found.archive.aid > 0 ? { aid: found.archive.aid } : {}),
  };
}
