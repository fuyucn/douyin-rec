import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeTarget, navSections } from "../../packages/web/src/lib/nav.js";

describe("navSections", () => {
  it("worker (no hub): tasks only — rooms/hub/queue need master-only endpoints", () => {
    const nav = navSections(false);
    expect(nav.primary.map((i) => i.to)).toEqual(["/"]);
    expect(nav.advanced).toEqual([]);
  });
  it("master: rooms primary; queue is the only advanced item", () => {
    const nav = navSections(true);
    expect(nav.primary.map((i) => i.to)).toEqual(["/rooms"]);
    expect(nav.advanced.map((i) => i.to)).toEqual(["/queue"]);
    expect(nav.advanced[0]?.end).toBe(true);
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
  });
  it("home target waits for hub detection, then chooses Rooms on master and Tasks on worker", () => {
    expect(homeTarget(null)).toBeNull();
    expect(homeTarget(true)).toBe("/rooms");
    expect(homeTarget(false)).toBe("/tasks");
  });
});
