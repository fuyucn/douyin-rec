// app/src/hub-label-lookup.ts
// Lookup tables for hub notification enrichment (observability enrichHubEvent), plus a wrapper
// that can never throw: the hub notify call sits between ledger.markDone and post-upload cleanup,
// so a failed lookup must degrade to the raw event instead of aborting the pipeline.
import { platformForRoom, type NotifyEvent } from "@drec/core";
import { enrichHubEvent, type HubLabelLookup } from "@drec/observability";

export interface HubLabelSources {
  tasks: () => readonly { id: number; room: string; anchorName?: string | null; name?: string | null }[];
  workers: () => readonly { id: string; name?: string }[];
  /** Anchor name resolved by the running recorder (freshest source). */
  liveAnchor: (taskId: number) => string | null | undefined;
}

/** Snapshot tasks/workers once per event; anchor priority matches the hub queue page. */
export function makeHubLabelLookup(src: HubLabelSources): HubLabelLookup {
  const tasks = src.tasks();
  const workers = src.workers();
  const matches = (room: string, platform: string, roomSlug: string): boolean => {
    try {
      const p = platformForRoom(room);
      return p.id === platform && p.extractRoomSlug(room) === roomSlug;
    } catch {
      return false; // One unparseable task must not hide the others.
    }
  };
  return {
    anchorOf: (platform, roomSlug) => {
      const t = tasks.find((task) => matches(task.room, platform, roomSlug));
      return t ? src.liveAnchor(t.id) || t.anchorName || t.name || undefined : undefined;
    },
    workerName: (id) => workers.find((w) => w.id === id)?.name || undefined,
  };
}

/** enrichHubEvent that falls back to the original event on any error (logged, not silent). */
export function enrichHubEventSafely(
  e: NotifyEvent,
  makeLookup: () => HubLabelLookup,
  warn: (m: string) => void = (m) => console.warn(m),
): NotifyEvent {
  try {
    return enrichHubEvent(e, makeLookup());
  } catch (err) {
    warn(`[hub] notification enrichment failed, sending raw event: ${(err as Error)?.message ?? err}`);
    return e;
  }
}
