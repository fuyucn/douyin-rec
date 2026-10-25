import { describe, expect, it } from "vitest";
import { navItems } from "../../packages/web/src/lib/nav.js";

describe("navItems", () => {
  it("worker (no hub): tasks only — rooms/hub/queue need master-only endpoints", () => {
    expect(navItems(false).map((i) => i.to)).toEqual(["/"]);
  });
  it("master: rooms first, then tasks, hub, queue", () => {
    expect(navItems(true).map((i) => i.to)).toEqual(["/rooms", "/", "/hub", "/queue"]);
  });
  it("only the tasks link matches exactly; /rooms also highlights on /rooms/:key", () => {
    const items = navItems(true);
    expect(items.find((i) => i.to === "/")?.end).toBe(true);
    expect(items.find((i) => i.to === "/rooms")?.end).toBeFalsy();
  });
  it("keeps legacy task and hub routes available while rooms parity work is in progress", () => {
    const paths = navItems(true).map((i) => i.to);
    expect(paths).toContain("/");
    expect(paths).toContain("/hub");
  });
});
