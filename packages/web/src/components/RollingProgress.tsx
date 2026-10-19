/**
 * RollingProgress — live rolling-upload progress of one room (Tasks detail and Rooms detail).
 * Data = the master queue snapshot's `delivering`, filtered by room slug; polled every 10 s.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type RollingDeliveryDTO } from "../api/client";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtBytes } from "../lib/nodes-summary";

/**
 * `slug` must come from `roomSlugOf` (same rule as the backend's extractRoomSlug): `roomId` only returns the
 * room number for douyin, so bilibili / kuaishou would never match the snapshot. `null` = not known yet.
 */
export function useRoomRolling(slug: string | null): RollingDeliveryDTO[] {
  const [rolling, setRolling] = useState<RollingDeliveryDTO[]>([]);
  // Drop the previous room's rows on room change (the page stays mounted when navigating room to room).
  useEffect(() => setRolling([]), [slug]);
  const poll = useCallback(async (): Promise<void> => {
    if (slug === null) return;
    try {
      const q = await api.getHubQueue({ q: slug || undefined });
      setRolling((q.delivering ?? []).filter((d) => !slug || d.roomSlug === slug));
    } catch {
      /* not a master / queue unavailable → keep the last result instead of blanking known progress */
    }
  }, [slug]);
  // The snapshot comes from the master's status poll; refetching faster only rescans the ledger.
  usePolling(() => void poll(), 10_000, slug !== null);
  return rolling;
}

/** One line per rolling session; the caller wraps it in its own info group. */
export function RollingProgressRows({ rolling }: { rolling: RollingDeliveryDTO[] }): ReactNode {
  const t = useT();
  return rolling.map((d) => (
    <div key={d.sessionBase} className="py-2 border-b border-hairline last:border-0 last:pb-0">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="font-mono text-muted-soft">{d.sessionBase}</span>
        <span className="ml-auto">{t("queue.delivering.progress", { c: d.confirmed, n: d.total })}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted font-mono mt-0.5">
        {d.uploading && <span>{t("queue.delivering.pending")}</span>}
        {typeof d.lockedBytes === "number" && d.lockedBytes > 0 && <span>{fmtBytes(d.lockedBytes)}</span>}
        {d.ambiguous > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.delivering.unknown")} {d.ambiguous}</span>}
        {d.bv && (
          <a className="hover:text-ink" href={`https://www.bilibili.com/video/${d.bv}`} target="_blank" rel="noreferrer">{d.bv}</a>
        )}
      </div>
    </div>
  ));
}
