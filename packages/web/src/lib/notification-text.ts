/**
 * notification-text.ts — in-app event → toast text (pure; split out of notifications.ts so it can be
 * tested without React). Issue #53 N6: when an event carries structured context (`ctx`), the toast
 * names the live room (display name by the shared chain + date) and shows the next step for errors.
 * Events without `ctx` (older servers / nodes) render exactly as before.
 */
import type { AppEventDTO, NotifKey } from "@drec/contracts";

export type ToastKind = "success" | "error" | "warning" | "info";
type T = (key: string, vars?: Record<string, string | number>) => string;

/** Last path segment (display only). */
function baseName(p?: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** Only the string fields we render; anything else in `ctx` is ignored. */
function ctxOf(ev: Record<string, unknown>): { name?: string; date?: string; time?: string; next?: string } {
  const c = ev.ctx;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  const o = c as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : undefined);
  return { name: str("name"), date: str("date"), time: str("time"), next: str("next") };
}

/** Event → { toggle key, text, toast kind }; null = no toast for this kind. */
export function describeEvent(e: AppEventDTO, t: T): { key: NotifKey; message: string; type: ToastKind } | null {
  const ev = e.event as unknown as Record<string, unknown> & { kind: string };
  const s = (k: string): string => String(ev[k] ?? "");
  const ctx = ctxOf(ev);
  const when = ctx.date ? `${ctx.date}${ctx.time ? ` ${ctx.time}` : ""}` : s("date");
  // Session label for hub events: `name · date` from ctx, else the enriched anchor/date, else the raw room.
  const session = (fallback: string): string => {
    const name = ctx.name || s("anchor");
    return name ? `${name}${when ? ` · ${when}` : ""}` : fallback;
  };
  switch (ev.kind) {
    case "recordStart":
      return { key: "live", message: t("notif.evLive", { anchor: s("anchor") || ctx.name || s("room") }), type: "info" };
    case "recordEnd": {
      const reason = s("reason");
      return { key: "recordEnd", message: t("notif.evRecordEnd", { anchor: s("anchor") || ctx.name || s("room"), reason: reason ? `（${reason}）` : "" }), type: "success" };
    }
    case "recordReconnect":
      return { key: "live", message: t("notif.evReconnect", { anchor: s("anchor") || ctx.name || s("room"), sec: s("downSec") }), type: "warning" };
    case "mergeDone":
      return { key: "merge", message: t("notif.evMerge", { file: baseName(s("file")) }), type: "success" };
    case "burnDone":
      return { key: "merge", message: t("notif.evBurn", { file: baseName(s("file")) }), type: "success" };
    case "uploadDone": {
      const who = session("");
      return { key: "merge", message: t("notif.evUpload", { bv: who ? `${who} · ${s("bv")}` : s("bv") }), type: "success" };
    }
    case "stageReady":
      return { key: "merge", message: t("notif.evStageReady", { room: session(s("streamKey")) }), type: "success" };
    case "hubTaskStart": {
      const workers = Array.isArray(ev.workers) ? (ev.workers as unknown[]).length : 0;
      return { key: "hub", message: t("notif.evHubStart", { room: session(s("room")), count: workers }), type: "info" };
    }
    case "error": {
      const base = ctx.name
        ? t("notif.evErrorNamed", { name: ctx.name, stage: s("stage"), message: s("message") })
        : t("notif.evError", { stage: s("stage"), message: s("message") });
      return { key: "error", message: ctx.next ? `${base} ${t("notif.next", { next: ctx.next })}` : base, type: "error" };
    }
    default:
      return null;
  }
}
