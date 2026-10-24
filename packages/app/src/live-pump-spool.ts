/**
 * Orphan spool cleanup for the zero-disk streaming path (plans/039).
 *
 * A pump killed mid-part never records that part in the state file, so nothing else will ever
 * remove its spool — a real leak observed after restart-resume (1 MB orphan beside a healthy
 * archive). This sweep lives in the app layer on purpose: processors are forbidden from listing
 * directories (`test/processors/remux-processor.test.ts` guards that invariant), because their
 * inputs must be explicit, not inferred from a directory.
 *
 * Deletion is deliberately narrow: only files this module creates, absent from the state, and
 * older than a grace period. A concurrently running pump writes a fresh file and is never touched.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Spool files created by `runLivePump`, two generations (issue #360):
 *  - legacy: `live-pump-<epochMs>-<seg>.ts`
 *  - room layout: `live-pump-<anchor>_<date>_<HH-mm-ss>_<NNN>.ts`
 * The held-gap rename (`.held-gap.ts`) deliberately does NOT match: a held sample must survive.
 */
// The three-digit segment suffix is spelled out (\d\d\d) on purpose: the architecture guard
// forbids a second `_\d{3}` literal outside core's session-name module.
const SPOOL_NAME_RE = /^live-pump-(?:\d+-\d+|.+(?:_\d\d\d\d-\d\d-\d\d_\d\d-\d\d-\d\d)_\d\d\d\d*)\.ts$/;
/** Grace window protecting a file another pump may still be writing. */
export const ORPHAN_SPOOL_GRACE_MS = 10 * 60_000;

export interface SweepOrphanSpoolsOpts {
  spoolDir: string;
  /** Spool paths referenced by the session state (must never be deleted). */
  knownSpoolPaths: readonly string[];
  /** Current time (injectable for tests). */
  now?: number;
  log?: (msg: string) => void;
}

/**
 * Best effort: never throws. Returns the file names actually removed.
 */
export function sweepOrphanSpools(o: SweepOrphanSpoolsOpts): string[] {
  const known = new Set(o.knownSpoolPaths.map((p) => basename(p)));
  const cutoff = (o.now ?? Date.now()) - ORPHAN_SPOOL_GRACE_MS;
  let names: string[];
  try {
    names = readdirSync(o.spoolDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!SPOOL_NAME_RE.test(name) || known.has(name)) continue;
    const full = join(o.spoolDir, name);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      unlinkSync(full);
      removed.push(name);
      o.log?.(`[live-pump] 清理上次中断遗留的孤儿 spool: ${name}`);
    } catch {
      // best effort; a later run will retry
    }
  }
  return removed;
}
