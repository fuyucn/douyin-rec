import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import type { RemoteTaskSpec } from "@drec/core";

/**
 * Issue #480: one malformed delivered spec must not abort the whole batch, and — crucially — a skipped item
 * must never be treated as "absent from the desired set", i.e. it must not delete/disable a local managed task
 * for that room. Deletion is guarded two ways:
 *  - slug derivable from the bad item -> that room's key is protected;
 *  - slug not derivable at all       -> the deletion/disable phase is skipped entirely this round.
 */
describe("applyRemoteTasks: bad spec is skipped, batch still applies (issue #480)", () => {
  let dir: string;
  let store: TaskStore;

  const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
    platform: "douyin",
    roomSlug: "123456",
    room: "https://live.douyin.com/123456",
    name: "主播A",
    quality: "origin",
    engine: "ffmpeg",
    danmu: 1,
    segmentSec: 1800,
    scheduleStart: null,
    scheduleEnd: null,
    enabled: true,
    useCookie: true,
    cookies: null,
    outDir: null,
    webhook: null,
    anchorName: null,
    rollingUpload: false, rollingEffective: false,
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-sync-480-"));
    store = new TaskStore(join(dir, "tasks.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("one bad + one good → the good room is applied, the bad one is skipped and logged (no cookies in the log)", () => {
    const logs: string[] = [];
    const bad = { platform: "douyin", roomSlug: "999", room: null, cookies: "SECRET=abc" };
    const r = applyRemoteTasks(store, [spec({ roomSlug: "111", room: "https://live.douyin.com/111" }), bad as never], (m) => logs.push(m));
    expect(r.applied).toEqual(["douyin:111"]);
    expect(store.listTasks().map((t) => t.room)).toEqual(["https://live.douyin.com/111"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped![0].reason).toContain("room");
    expect(logs.some((m) => m.includes("跳过第 2 条期望"))).toBe(true);
    expect(logs.some((m) => m.includes("跳过 1 条坏条目"))).toBe(true);
    expect(logs.join(String.fromCharCode(10))).not.toContain("SECRET=abc"); // credentials never leak into the log
  });

  it("a bad item whose room already has a managed task → that task is neither deleted nor disabled, while other rooms still sync", () => {
    // force=true keeps the shrink valve out of the picture, so the deletion loop really runs this round and
    // the per-room protection is what keeps the broken room's task alive.
    const kept = store.addTask({ room: "https://live.douyin.com/111" });
    const broken = store.addTask({ room: "https://live.douyin.com/222" });
    const dropped = store.addTask({ room: "https://live.douyin.com/333" });
    applyRemoteTasks(store, [
      spec({ roomSlug: "111", room: "https://live.douyin.com/111" }),
      spec({ roomSlug: "222", room: "https://live.douyin.com/222" }),
      spec({ roomSlug: "333", room: "https://live.douyin.com/333" }),
    ]);
    for (const id of [kept.id, broken.id, dropped.id]) expect(store.getTask(id)?.managedBy).toBe("hub");
    // Make 333 removable in this round (two-phase deletion would only disable it otherwise).
    store.setEnabled(dropped.id, false);

    const logs: string[] = [];
    // Truncated spec for room 222: platform/roomSlug are gone but the room is still identifiable.
    const r = applyRemoteTasks(
      store,
      [
        spec({ roomSlug: "111", room: "https://live.douyin.com/111" }),
        { room: "https://live.douyin.com/222" } as never,
      ],
      (m) => logs.push(m),
      { force: true },
    );
    expect(r.skipped).toHaveLength(1);
    expect(store.getTask(kept.id)?.managedBy).toBe("hub");       // still applied
    expect(store.getTask(broken.id)).toMatchObject({ managedBy: "hub", enabled: true }); // NOT treated as absent
    expect(store.getTask(dropped.id)).toBeNull();                 // genuinely absent rooms still removed
    expect(r.removed).toEqual(["douyin:333"]);
    expect(r.pending).toEqual([]);
    expect(logs.some((m) => m.includes("不按缺席处理"))).toBe(true);
  });

  it("an unparsable item whose room is unknown → no deletions at all this round", () => {
    for (const room of ["https://live.douyin.com/1", "https://live.douyin.com/2", "https://live.douyin.com/3"]) {
      const t = store.addTask({ room });
      applyRemoteTasks(store, [spec({ roomSlug: room.split("/").pop()!, room })], undefined, { adopt: false });
      store.setManagedBy(t.id, "hub");
    }
    expect(store.listTasks()).toHaveLength(3);

    const logs: string[] = [];
    // The only delivered item is garbage: no room, no platform, no slug.
    const r = applyRemoteTasks(store, [{ name: "oops" } as never], (m) => logs.push(m), { force: true });
    expect(r.skipped).toHaveLength(1);
    expect(r.removed).toEqual([]);
    expect(store.listTasks().map((t) => t.enabled)).toEqual([true, true, true]);
    expect(store.listTasks()).toHaveLength(3);
    expect(logs.some((m) => m.includes("跳过全部删除/停用"))).toBe(true);
  });

  it("all-good batch is unchanged: applied/removed/pending identical, no skipped field", () => {
    const a = store.addTask({ room: "https://live.douyin.com/111" });
    const b = store.addTask({ room: "https://live.douyin.com/222" });
    // Two managed rooms on this node, only one still desired → the other is removed (unchanged behaviour).
    applyRemoteTasks(store, [
      spec({ roomSlug: "111", room: "https://live.douyin.com/111" }),
      // Disabled so the later removal is immediate (two-phase deletion of a running/enabled task is covered
      // by the existing T3 tests; this case is only about an all-good batch staying unchanged).
      spec({ roomSlug: "222", room: "https://live.douyin.com/222", enabled: false }),
    ]);
    expect(store.getTask(b.id)?.managedBy).toBe("hub");
    const r = applyRemoteTasks(store, [spec({ roomSlug: "111", room: "https://live.douyin.com/111" })], undefined, { force: true });
    expect(r.applied).toEqual(["douyin:111"]);
    expect(r.removed).toEqual(["douyin:222"]);
    expect(r.pending).toEqual([]);
    expect(r.skipped).toBeUndefined(); // old masters see the exact previous shape
    expect(store.getTask(a.id)?.managedBy).toBe("hub");
  });
});

