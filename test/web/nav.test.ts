import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeTarget, navSections } from "../../packages/web/src/lib/nav.js";

const APP = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "App.tsx"), "utf-8");

/** 每条 `<Route>` 在 App.tsx 里都是单行,按路径取回该行(断言跳转目标/守卫组件)。 */
const routeLine = (path: string): string =>
  APP.split("\n").find((line) => line.includes(`<Route path="${path}"`)) ?? "";

describe("navSections", () => {
  it("worker (no hub): 只有「房间」一个 primary —— nodes/queue/stats 要 master-only 端点", () => {
    const nav = navSections(false);
    expect(nav.primary).toEqual([{ to: "/rooms", labelKey: "nav.rooms" }]);
    expect(nav.advanced).toEqual([]);
  });
  it("master: rooms and nodes primary; queue is the only advanced item", () => {
    const nav = navSections(true);
    expect(nav.primary.map((i) => i.to)).toEqual(["/rooms", "/nodes", "/stats"]);
    expect(nav.advanced.map((i) => i.to)).toEqual(["/queue"]);
    expect(nav.advanced[0]?.end).toBe(true);
  });
  it("rooms also stays active on /rooms/:key", () => {
    const nav = navSections(true);
    expect(nav.primary.find((i) => i.to === "/rooms")?.end).toBeFalsy();
    expect(navSections(false).primary.find((i) => i.to === "/rooms")?.end).toBeFalsy();
  });
});

describe("App routes (plans/047 §4.1)", () => {
  it("/tasks 与 /task/:id 是跳转,不再是旧页面", () => {
    const tasks = routeLine("/tasks");
    expect(tasks).toContain("<Navigate");
    expect(tasks).toContain('"/rooms"');
    expect(tasks).not.toContain("<TaskList");
    // /task/:id 走「任务 id → 房间 key」的二次跳转,保留 query(?logs=1)。
    const task = routeLine("/task/:id");
    expect(task).toContain("<TaskIdRedirect />");
    expect(task).not.toContain("<TaskDetail");
    expect(APP).toContain("/rooms/by-task/");
    expect(APP).not.toContain("import { TaskList }");
    expect(APP).not.toContain("import { TaskDetail }");
  });
  it("任务 id → 房间 key 解析路由与新房间入口都在", () => {
    const byTask = routeLine("/rooms/by-task/:id");
    expect(byTask).toContain("<RoomByTaskRedirect />");
    expect(routeLine("/rooms")).toContain("<RoomsPage />");
    expect(routeLine("/rooms/:key")).toContain("<RoomPage />");
    // 找不到房间时回落列表,而不是留在一个死路由。
    expect(APP).toContain('target ?? "/rooms"');
  });
  it("master-only 页面(节点/队列/统计)在 worker 上被 MasterOnly 挡住", () => {
    expect(routeLine("/nodes")).toContain("<MasterOnly");
    expect(routeLine("/nodes")).toContain("<NodesPage />");
    expect(routeLine("/queue")).toContain("<MasterOnly");
    expect(routeLine("/queue")).toContain("<QueuePage />");
    expect(routeLine("/stats")).toContain("<MasterOnly");
    expect(routeLine("/stats")).toContain("<StatsPage />");
  });
  it("Hub 规则页保持现状(worker 由 HubPage 自己的 child-node 卡兜住)", () => {
    expect(routeLine("/hub")).toContain("<HubPage />");
    expect(routeLine("/hub/:key")).toContain("<HubPage />");
  });
});

describe("homeTarget", () => {
  it("等 hub 探测完成,然后所有节点都回 Rooms", () => {
    expect(homeTarget(null)).toBeNull();
    expect(homeTarget(true)).toBe("/rooms");
    expect(homeTarget(false)).toBe("/rooms");
  });
});
