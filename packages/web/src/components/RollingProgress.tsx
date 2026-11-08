/**
 * RollingProgress — live rolling-upload progress of one room (Tasks detail and Rooms detail).
 * Data = the master queue snapshot's `delivering`, filtered by room slug; polled every 10 s.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RollingDeliveryDTO } from "../api/client";
import { usePolling } from "../lib/hooks";

/**
 * `slug` must come from `roomSlugOf` (same rule as the backend's extractRoomSlug): `roomId` only returns the
 * room number for douyin, so bilibili / kuaishou would never match the snapshot. `null` = not known yet.
 */
export function useRoomRolling(slug: string | null): RollingDeliveryDTO[] {
  const [rolling, setRolling] = useState<RollingDeliveryDTO[]>([]);
  // Drop the previous room's rows on room change (the page stays mounted when navigating room to room).
  // A response for a previous room can arrive after the reset; the ref lets it see it is stale.
  const current = useRef(slug);
  useEffect(() => { current.current = slug; setRolling([]); }, [slug]);
  const poll = useCallback(async (): Promise<void> => {
    if (slug === null) return;
    try {
      const q = await api.getHubQueue({ q: slug || undefined });
      if (current.current !== slug) return;
      setRolling((q.delivering ?? []).filter((d) => !slug || d.roomSlug === slug));
    } catch {
      /* not a master / queue unavailable → keep the last result instead of blanking known progress */
    }
  }, [slug]);
  // The snapshot comes from the master's status poll; refetching faster only rescans the ledger.
  usePolling(() => void poll(), 10_000, slug !== null);
  return rolling;
}
