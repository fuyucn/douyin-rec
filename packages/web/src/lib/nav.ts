// lib/nav.ts — top-nav entries (pure, so the master/worker gating is testable without a DOM).

export interface NavItem {
  to: string;
  /** i18n key; "Hub" is a literal label. */
  labelKey: string;
  end?: boolean;
}

/**
 * Rooms / Hub / Queue need master-only endpoints (`/api/hub/*`, incl. the hub change stream that
 * answers 503 on a worker), so they only show when hub is enabled. Order on master: rooms first
 * (one-stop entry: list → detail → edit), then tasks, Hub (configure) and queue (observe).
 */
export function navItems(hubEnabled: boolean): NavItem[] {
  if (!hubEnabled) return [{ to: "/", labelKey: "nav.tasksList", end: true }];
  return [
    { to: "/rooms", labelKey: "nav.rooms" },
    { to: "/", labelKey: "nav.tasksList", end: true },
    { to: "/hub", labelKey: "Hub" },
    { to: "/queue", labelKey: "nav.queue" },
  ];
}
