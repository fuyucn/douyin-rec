import { describe, expect, it } from "vitest";
import { homeTarget, navSections } from "../../packages/web/src/lib/nav.js";

describe("navSections", () => {
  it("worker (no hub): tasks only — rooms/hub/queue need master-only endpoints", () => {
    const nav = navSections(false);
    expect(nav.primary.map((i) => i.to)).toEqual(["/"]);
    expect(nav.advanced).toEqual([]);
  });
  it("master: rooms primary; tasks, hub, queue under advanced", () => {
    const nav = navSections(true);
    expect(nav.primary.map((i) => i.to)).toEqual(["/rooms"]);
    expect(nav.advanced.map((i) => i.to)).toEqual(["/tasks", "/hub", "/queue"]);
  });
  it("tasks matches exactly; /rooms also highlights on /rooms/:key", () => {
    const nav = navSections(true);
    expect(nav.advanced.find((i) => i.to === "/tasks")?.end).toBe(true);
    expect(nav.primary.find((i) => i.to === "/rooms")?.end).toBeFalsy();
  });
  it("home target waits for hub detection, then chooses Rooms on master and Tasks on worker", () => {
    expect(homeTarget(null)).toBeNull();
    expect(homeTarget(true)).toBe("/rooms");
    expect(homeTarget(false)).toBe("/tasks");
  });
});
