/**
 * cookie-resolution.test.ts — the per-task `useCookie` gate.
 *
 * resolveTaskCookies is the SINGLE source of truth used by BOTH recording
 * paths (task run via buildSessionForTask → opts.cookies, and the subprocess
 * path via TaskManager.spawnFor → effective.cookies → buildRecordArgs). We
 * test that shared helper directly, then assert buildRecordArgs reflects it on
 * the effective task (mirroring spawnFor) — without dragging in the real
 * recorder/Spawner/subprocess world.
 *
 * Rule:
 *   useCookie=false → null (anonymous danmu — comments only).
 *   useCookie=true  → task.cookies override, else global defaultCookies, else null.
 */
import { describe, it, expect } from "vitest";
import { TaskStore, resolveTaskCookies, type Task } from "../../packages/app/src/store.js";
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";

const GLOBAL = "sessionid=GLOBAL";

describe("resolveTaskCookies", () => {
  it("useCookie=false → null even when global cookie set", () => {
    expect(resolveTaskCookies({ useCookie: false, cookies: null }, GLOBAL)).toBeNull();
  });

  it("useCookie=true + global set → global cookie", () => {
    expect(resolveTaskCookies({ useCookie: true, cookies: null }, GLOBAL)).toBe(GLOBAL);
  });

  it("useCookie=true + task.cookies override → override (not global)", () => {
    expect(
      resolveTaskCookies({ useCookie: true, cookies: "sessionid=OVERRIDE" }, GLOBAL),
    ).toBe("sessionid=OVERRIDE");
  });

  it("useCookie=true + nothing set → null (anonymous)", () => {
    expect(resolveTaskCookies({ useCookie: true, cookies: null }, null)).toBeNull();
  });
});

/** Resolve effective cookies exactly as TaskManager.spawnFor does. */
function effective(task: Task, store: TaskStore): Task {
  return { ...task, cookies: resolveTaskCookies(task, store.getDefaultCookies()) };
}

describe("subprocess path — effective task + buildRecordArgs", () => {
  it("useCookie=false → no --cookies even with global set", () => {
    const store = new TaskStore(":memory:");
    store.setSetting("defaultCookies", GLOBAL);
    const t = store.addTask({ room: "111", useCookie: false });
    expect(buildRecordArgs(effective(t, store))).not.toContain("--cookies");
    store.close();
  });

  it("useCookie=true + global set → --cookies <global>", () => {
    const store = new TaskStore(":memory:");
    store.setSetting("defaultCookies", GLOBAL);
    const t = store.addTask({ room: "111", useCookie: true });
    const args = buildRecordArgs(effective(t, store));
    expect(args[args.indexOf("--cookies") + 1]).toBe(GLOBAL);
    store.close();
  });

  it("useCookie=true + task.cookies override → --cookies <override>", () => {
    const store = new TaskStore(":memory:");
    store.setSetting("defaultCookies", GLOBAL);
    const t = store.addTask({ room: "111", useCookie: true, cookies: "sessionid=OVERRIDE" });
    const args = buildRecordArgs(effective(t, store));
    expect(args[args.indexOf("--cookies") + 1]).toBe("sessionid=OVERRIDE");
    store.close();
  });
});
