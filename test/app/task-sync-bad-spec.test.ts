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
 *  - slug derivable from the bad item -> that room's key is protected (delete loop, guard disableOnly, and the
 *    DREC_EXPLICIT_DELETE=1 fast path all honour it);
 *  - slug not derivable at all       -> the deletion/disable phase is skipped entirely this round.
 *
 * The delete-safety cases below deliberately avoid force:true (which bypasses the guard) and one of them turns
 * on DREC_EXPLICIT_DELETE, so each of the four protection points is mutation-sensitive.
 */
describe("applyRemoteTasks: bad spec is skipped, batch still applies (issue #480)", () => {
  let dir: string;
  let store: TaskStore;
  const savedEnv: Record<string, string | undefined> = {};

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
  const room = (n: string): RemoteTaskSpec => spec({ roomSlug: n, room: `https://live.douyin.com/${n}` });

  /** Adopt N existing rooms as managed, all enabled. */
  const seedManaged = (rooms: string[]): void => {
    for (const n of rooms) store.addTask({ room: `https://live.douyin.com/${n}` });
    applyRemoteTasks(store, rooms.map(room));
    for (const t of store.listTasks()) expect(t.managedBy).toBe("hub");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-sync-480-"));
    store = new TaskStore(join(dir, "tasks.db"));
    for (const k of ["DREC_EXPLICIT_DELETE", "DREC_ALLOW_SHRINK"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("one bad + one good → the good room is applied, the bad one is skipped and logged (no cookies in the log)", () => {
    const logs: string[] = [];
    const bad = { platform: "douyin", roomSlug: "999", room: null, cookies: "SECRET=abc" };
    const r = applyRemoteTasks(store, [room("111"), bad as never], (m) => logs.push(m));
    expect(r.applied).toEqual(["douyin:111"]);
    expect(store.listTasks().map((t) => t.room)).toEqual(["https://live.douyin.com/111"]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped![0].reason).toContain("room");
    expect(logs.some((m) => m.includes("跳过第 2 条期望"))).toBe(true);
    expect(logs.some((m) => m.includes("跳过 1 条坏条目"))).toBe(true);
    expect(logs.join(String.fromCharCode(10))).not.toContain("SECRET=abc"); // credentials never leak into the log
  });

  it("(a) non-force, 4 enabled managed rooms, [good, bad-with-derivable-room] → bad room stays enabled, not pending", () => {
    seedManaged(["1", "2", "3", "4"]);
    // Force-free and only 2 retained rooms of 4 → the mass-shrink valve fires and only disables; the bad
    // room must be excluded from that disable list.
    const logs: string[] = [];
    const r = applyRemoteTasks(
      store,
      [room("1"), { room: "https://live.douyin.com/2" } as never],
      (m) => logs.push(m),
    );
    expect(r.rejected).toBe("mass-shrink");
    const bad = store.listTasks().find((t) => t.room === "https://live.douyin.com/2")!;
    expect(bad).toMatchObject({ managedBy: "hub", enabled: true }); // NOT disabled by the valve
    expect(r.pending).not.toContain("douyin:2");
    expect(r.removed).toEqual([]);
    expect(logs.some((m) => m.includes("不按缺席处理") || m.includes("坏条目"))).toBe(true);
  });

  it("(b) non-force, unknown-room bad item + absent rooms → nothing disabled, no rejection", () => {
    seedManaged(["1", "2", "3", "4"]);
    // With protected rooms counted, the expected set is still 4-ish, so the valve does not fire; and because
    // the room is unknown the whole delete/disable phase must be skipped.
    const logs: string[] = [];
    const r = applyRemoteTasks(store, [{ name: "oops" } as never], (m) => logs.push(m));
    expect(r.skipped).toHaveLength(1);
    expect(r.rejected).toBeUndefined(); // guard must not run at all
    expect(r.removed).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(store.listTasks().every((t) => t.enabled && t.managedBy === "hub")).toBe(true);
    expect(logs.some((m) => m.includes("跳过全部删除/停用"))).toBe(true);
  });


  it("(a2) non-force, healthy ratio: the normal two-phase delete loop must not touch the broken room", () => {
    seedManaged(["1", "2", "3"]);
    // 2 good rooms retained + 1 protected = 3 of 3 enabled → no shrink rejection, so the deletion loop really
    // runs; the broken room must be skipped there instead of being disabled as "absent".
    const logs: string[] = [];
    const r = applyRemoteTasks(
      store,
      [room("1"), room("2"), { room: "https://live.douyin.com/3" } as never],
      (m) => logs.push(m),
    );
    expect(r.rejected).toBeUndefined();
    expect(store.listTasks().find((t) => t.room === "https://live.douyin.com/3"))
      .toMatchObject({ managedBy: "hub", enabled: true });
    expect(r.pending).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(logs.some((m) => m.includes("不按缺席处理"))).toBe(true);
  });

  it("(c) DREC_EXPLICIT_DELETE=1 + deleted:true: unknown-room bad item → no removal; derivable-room bad item → protected", () => {
    process.env.DREC_EXPLICIT_DELETE = "1";
    seedManaged(["1", "2", "3"]);
    // Unknown room: even the explicit fast path must not delete anything.
    const logs: string[] = [];
    const r1 = applyRemoteTasks(
      store,
      [spec({ ...room("1"), deleted: true }), { name: "oops" } as never],
      (m) => logs.push(m),
    );
    expect(r1.removed).toEqual([]);
    expect(store.listTasks()).toHaveLength(3);
    expect(logs.some((m) => m.includes("跳过全部删除/停用"))).toBe(true);

    // Derivable room: the explicitly deleted room 3 IS removed (intent honoured), while room 2 — whose spec
    // failed to parse — is protected from the fast path.
    const logs2: string[] = [];
    const r2 = applyRemoteTasks(
      store,
      [spec({ ...room("1"), deleted: true }), spec({ ...room("2"), deleted: true }), { room: "https://live.douyin.com/2" } as never],
      (m) => logs2.push(m),
    );
    expect(r2.removed).toEqual(["douyin:1"]);
    expect(store.listTasks().map((t) => t.room).sort()).toEqual([
      "https://live.douyin.com/2", "https://live.douyin.com/3",
    ]);
    expect(logs2.some((m) => m.includes("保留受管任务"))).toBe(true);
  });

  it("all-good batch is unchanged: applied/removed/pending identical, no skipped field, room bytes untouched", () => {
    const a = store.addTask({ room: "https://live.douyin.com/111" });
    const b = store.addTask({ room: "https://live.douyin.com/222" });
    applyRemoteTasks(store, [room("111"), spec({ ...room("222"), enabled: false })]);
    expect(store.getTask(b.id)?.managedBy).toBe("hub");
    const r = applyRemoteTasks(store, [room("111")], undefined, { force: true });
    expect(r.applied).toEqual(["douyin:111"]);
    expect(r.removed).toEqual(["douyin:222"]);
    expect(r.pending).toEqual([]);
    expect(r.skipped).toBeUndefined(); // old masters see the exact previous shape
    expect(store.getTask(a.id)).toMatchObject({ managedBy: "hub", room: "https://live.douyin.com/111" });
  });
});

