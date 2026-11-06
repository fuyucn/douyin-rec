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
 * Queue reads local `/api/proc/active` on every node, so it is primary for both roles. Rooms,
 * Nodes, and Stats need master-only endpoints (`/api/hub/*`) and only show when hub is enabled;
 * Tasks remains the worker home, while legacy Tasks/Hub routes stay directly addressable.
 */
export function navSections(hubEnabled: boolean): NavSections {
  if (!hubEnabled) {
    return {
      primary: [
        { to: "/", labelKey: "nav.tasksList", end: true },
        { to: "/queue", labelKey: "nav.queue", end: true },
      ],
      advanced: [],
    };
  }
  return {
    primary: [
      { to: "/rooms", labelKey: "nav.rooms" },
      { to: "/nodes", labelKey: "nav.nodes" },
      { to: "/queue", labelKey: "nav.queue", end: true },
      { to: "/stats", labelKey: "nav.stats" },
    ],
    advanced: [],
  };
}
