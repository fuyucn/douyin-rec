import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeTarget, navSections } from "../../packages/web/src/lib/nav.js";

describe("navSections", () => {
  it("worker (no hub): tasks and the local queue are primary; advanced is empty", () => {
    const nav = navSections(false);
    expect(nav.primary.map((i) => i.to)).toEqual(["/", "/queue"]);
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
  });
  it("legacy Tasks/Hub routes remain available during the compatibility period", () => {
    const app = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "App.tsx"), "utf-8");
    expect(app).toContain('<Route path="/tasks"');
    expect(app).toContain('<Route path="/task/:id"');
    expect(app).toContain('<Route path="/hub"');
    expect(app).toContain('<Route path="/hub/:key"');
    expect(app).toContain('<Route path="/nodes"');
  });
  it("home target waits for hub detection, then chooses Rooms on master and Tasks on worker", () => {
    expect(homeTarget(null)).toBeNull();
    expect(homeTarget(true)).toBe("/rooms");
    expect(homeTarget(false)).toBe("/tasks");
  });
});
