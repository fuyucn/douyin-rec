// lib/nav.ts — top-nav entries (pure, so the master/worker gating is testable without a DOM).
//
// plans/047 §4.1: Rooms is the ONE user-visible entity, on every node. "Tasks" is no longer
// a product concept in the navigation — `/tasks` and `/task/:id` survive only as redirects.

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

/** null = hub capability still loading (wait). Otherwise Rooms is home on both roles. */
export function homeTarget(hubEnabled: boolean | null): "/rooms" | null {
  if (hubEnabled === null) return null;
  return "/rooms";
}

/**
 * master: 房间 / 节点 / 统计 + 高级「队列」(保持现状)。
 * worker: 只有「房间」—— /nodes /queue /stats 依赖 master-only 端点
 * (`/api/hub/*`,含 worker 上 503 的 hub 变更流),因此既不进导航也不进高级菜单。
 */
export function navSections(hubEnabled: boolean): NavSections {
  if (!hubEnabled) {
    return {
      primary: [{ to: "/rooms", labelKey: "nav.rooms" }],
      advanced: [],
    };
  }
  return {
    primary: [
      { to: "/rooms", labelKey: "nav.rooms" },
      { to: "/nodes", labelKey: "nav.nodes" },
      { to: "/stats", labelKey: "nav.stats" },
    ],
    advanced: [{ to: "/queue", labelKey: "nav.queue", end: true }],
  };
}
