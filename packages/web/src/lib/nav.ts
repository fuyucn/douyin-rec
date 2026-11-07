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
 * master: 房间 / 节点 / 队列 / 统计;worker: 房间 / 队列。
 *
 * Queue 对两种角色都是一等入口:它读本机 `/api/proc/active`(每个 `task serve` 都注入
 * ProcRunner),只有 `/api/hub/*` 是 master-only —— 那些区块在 QueuePage 里按 hubEnabled
 * 门住,worker 不会请求它们。
 *
 * Nodes 与 Stats 仍依赖 `/api/hub/*`(含 worker 上 503 的 hub 变更流),因此只在 master
 * 出现;旧的 `/tasks`、`/task/:id`、`/hub` 路由保持可直接访问,只是不再进主导航。
 */
export function navSections(hubEnabled: boolean): NavSections {
  if (!hubEnabled) {
    return {
      primary: [
        { to: "/rooms", labelKey: "nav.rooms" },
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
