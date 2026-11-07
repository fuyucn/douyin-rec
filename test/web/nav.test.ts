import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeTarget, navSections } from "../../packages/web/src/lib/nav.js";

const APP = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "App.tsx"), "utf-8");
const EDITOR = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "modals", "RoomEditor.tsx"), "utf-8");

/** 每条 `<Route>` 在 App.tsx 里都是单行,按路径取回该行(断言跳转目标/守卫组件)。 */
const routeLine = (path: string): string =>
  APP.split("\n").find((line) => line.includes(`<Route path="${path}"`)) ?? "";

describe("navSections", () => {
  it("worker (no hub): rooms and the local queue are primary; advanced is empty", () => {
    const nav = navSections(false);
    expect(nav.primary.map((i) => i.to)).toEqual(["/rooms", "/queue"]);
    expect(nav.primary.find((i) => i.to === "/queue")?.end).toBe(true);
    expect(nav.advanced).toEqual([]);
  });
  it("master: rooms, nodes, queue, and stats are primary; advanced is empty", () => {
    const nav = navSections(true);
    expect(nav.primary.map((i) => i.to)).toEqual(["/rooms", "/nodes", "/queue", "/stats"]);
    expect(nav.primary.find((i) => i.to === "/queue")?.end).toBe(true);
    expect(nav.advanced).toEqual([]);
  });
  it("queue is never left in the advanced menu", () => {
    expect(navSections(true).advanced.map((i) => i.to)).not.toContain("/queue");
    expect(navSections(false).advanced.map((i) => i.to)).not.toContain("/queue");
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
    expect(tasks).toContain("<TasksRedirect />");
    expect(APP).toContain("function TasksRedirect()");
    expect(APP).toContain('<Navigate to={{ pathname: "/rooms", search }} replace />');
    expect(tasks).not.toContain("<TaskList");
    // /task/:id 走「任务 id → 房间 key」的二次跳转,保留 query(?logs=1)。
    const task = routeLine("/task/:id");
    expect(task).toContain("<TaskIdRedirect />");
    expect(task).not.toContain("<TaskDetail");
    expect(APP).toContain("/rooms/by-task/");
    expect(APP).not.toContain("import { TaskList }");
    expect(APP).not.toContain("import { TaskDetail }");
  });
  it("worker 编辑器只请求平台列表,不打 master 专属 /api/hub/workers", () => {
    const workersCall = EDITOR.split("\n").find((line) => line.includes("api.listWorkers()")) ?? "";
    expect(workersCall.trimStart()).toMatch(/^if \(caps\.nodes\) void api\.listWorkers\(\)/);
    expect(EDITOR).toContain("void api.getPlatforms()");
    expect(EDITOR).toContain("}, [caps.nodes]);");
  });
  it("worker 录制 tab 说明边录边传与投稿配置在主控", () => {
    expect(EDITOR).toContain('t("room.editor.rollingByMaster")');
  });
  it("/tasks 重定向组件保留 search", () => {
    const body = APP.split("function TasksRedirect(): ReactNode {")[1]?.split("\n}")[0] ?? "";
    expect(body).toContain("const { search } = useLocation();");
    expect(body).toContain('<Navigate to={{ pathname: "/rooms", search }} replace />');
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

describe("node queue kinds dictionary coverage", () => {
  it("every known proc-queue kind has zh and en labels", () => {
    const queueSrc = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "pages", "QueuePage.tsx"), "utf-8");
    const dictSrc = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "lib", "i18n.tsx"), "utf-8");
    const eq = dictSrc.indexOf("=", dictSrc.indexOf("const DICT"));
    const open = dictSrc.indexOf("{", eq);
    let depth = 0;
    let end = -1;
    for (let i = open; i < dictSrc.length; i++) {
      if (dictSrc[i] === "{") depth++;
      else if (dictSrc[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    const dict = (0, eval)("(" + dictSrc.slice(open, end) + ")") as {
      zh: { queue: { nodeQueue: { kinds: Record<string, string> } } };
      en: { queue: { nodeQueue: { kinds: Record<string, string> } } };
    };
    const kindsMatch = queueSrc.match(/NODE_QUEUE_KINDS = \[([^\]]+)\]/);
    expect(kindsMatch).not.toBeNull();
    const kinds = [...kindsMatch![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(kinds).toContain("upload-part");
    expect(kinds).toContain("cleanup-part");
    expect(kinds).toContain("reconcile-part");
    expect(kinds).toContain("remux");
    expect(kinds).toContain("upload-prep");
    expect(kinds).toContain("biliup");
    expect(kinds).not.toContain("cleanup-spool");
    for (const kind of kinds) {
      expect(dict.zh.queue.nodeQueue.kinds[kind]).toBeTruthy();
      expect(dict.en.queue.nodeQueue.kinds[kind]).toBeTruthy();
    }
  });
});
