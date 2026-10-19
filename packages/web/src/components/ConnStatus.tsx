/** ConnStatus — list header pill: time of the last successful list fetch, or "disconnected" (Tasks and Rooms). */
import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { serverTimezoneAtom, type ConnState } from "../atoms";
import { useT } from "../lib/i18n";
import { fmtTimeInTz, localTimeTooltip } from "../lib/tz";
import { Tooltip } from "./Tooltip";

export function ConnStatus({ conn }: { conn: ConnState }): ReactNode {
  const t = useT();
  const serverTz = useAtomValue(serverTimezoneAtom);
  if (!conn) return null;
  return (
    <Tooltip
      content={
        conn.ok
          ? localTimeTooltip(new Date(conn.at), serverTz, (tz, local) => t("common.localTimeTooltip", { serverTz: tz, local }))
          : undefined
      }
    >
      <span
        className="hidden sm:inline-flex items-center gap-1.5 text-xs"
        style={{ color: conn.ok ? "var(--success-fg)" : "var(--error-fg)" }}
      >
        <span className="dot" style={{ background: conn.ok ? "var(--success)" : "var(--error)" }} />
        {conn.ok ? t("tasks.connected", { time: fmtTimeInTz(new Date(conn.at), serverTz) }) : t("tasks.connFailed")}
      </span>
    </Tooltip>
  );
}
