// lib/nav.ts — top-nav entries (pure, so the master/worker gating is testable without a DOM).

export interface NavItem {
  to: string;
  /** i18n key. */
  labelKey: string;
  end?: boolean;
}

export interface NavSections {
  primary: NavItem[];
  advanced: NavItem[];
}

/** null = hub capability still loading; master redirects to Rooms; worker renders Tasks in place. */
export function homeTarget(hubEnabled: boolean | null): "/rooms" | "/tasks" | null {
  if (hubEnabled === null) return null;
  return hubEnabled ? "/rooms" : "/tasks";
}

/**
 * Rooms / Queue / Nodes need master-only endpoints (`/api/hub/*`, incl. the hub change stream that
 * answers 503 on a worker), so they only show when hub is enabled. Tasks and Hub remain available
 * as legacy routes, but master navigation now uses Rooms as the one-stop entry; Queue is the only
 * remaining advanced view. Nodes is a first-class master page beside Rooms.
 */
export function navSections(hubEnabled: boolean): NavSections {
  if (!hubEnabled) {
    return {
      primary: [{ to: "/", labelKey: "nav.tasksList", end: true }],
      advanced: [],
    };
  }
  return {
    primary: [
      { to: "/rooms", labelKey: "nav.rooms" },
      { to: "/nodes", labelKey: "nav.nodes" },
    ],
    advanced: [{ to: "/queue", labelKey: "nav.queue", end: true }],
  };
}
