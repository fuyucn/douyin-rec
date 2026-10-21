/**
 * Issue #331 — hub-managed zero-disk task on a node: argv / env wiring, the pre-spawn refusal in
 * TaskManager, and that the delivered object is not exposed through the API view.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactTaskSecrets } from "@drec/core";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import { zeroDiskDeliveryEnv } from "../../packages/app/src/process/spawner.js";
import type { RecorderProcess, ExitInfo } from "../../packages/app/src/process/recorder-process.js";
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";
import { TaskStore, type Task } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import type { ZeroDiskPreflight } from "../../packages/app/src/zero-disk-node.js";

const DELIVERY = JSON.stringify({ v: 1, meta: { tid: 21, tag: "x", private: true }, accountKey: "bilibili:1" });

class FakeProc implements RecorderProcess {
  readonly pid = 1;
  started = false;
  constructor(readonly taskId: number) {}
  start(): void { this.started = true; }
  async stop(): Promise<void> { for (const cb of this.exits) cb({ code: 0, signal: null, expected: true }); }
  async stopGraceful(): Promise<void> {}
  private exits: Array<(i: ExitInfo) => void> = [];
  onExit(cb: (i: ExitInfo) => void): void { this.exits.push(cb); }
  onLog(): void {}
}
class MockSpawner implements Spawner {
  spawned: FakeProc[] = [];
  spawn(task: { id: number }): RecorderProcess {
    const p = new FakeProc(task.id);
    this.spawned.push(p);
    return p;
  }
}

const mkTask = (over: Partial<Task> = {}): Task => ({
  id: 1, room: "12345", name: "a", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800, cookies: null, outDir: null,
  scheduleStart: null, scheduleEnd: null, status: "stopped", useCookie: true, enabled: true, createdAt: "2026-01-01T00:00:00.000Z",
  webhook: null, managedBy: null, anchorName: null, rollingUpload: false, rollingEffective: false, streamUpload: false,
  streamUploadSpool: true, zeroDiskDelivery: null, outputFormat: "original", ...over,
} as Task);

describe("record argv / env for a managed zero-disk task", () => {
  it("only a hub-managed zero-disk task gets --zero-disk-managed and the delivery env", () => {
    const managed = mkTask({ streamUpload: true, managedBy: "hub", zeroDiskDelivery: DELIVERY });
    expect(buildRecordArgs(managed)).toEqual(expect.arrayContaining(["--stream-upload", "1", "--zero-disk-managed", "1"]));
    expect(zeroDiskDeliveryEnv(managed)).toEqual({ DREC_ZERO_DISK_DELIVERY: DELIVERY });

    // master-local (managedBy null) and plain recording are untouched
    const local = mkTask({ streamUpload: true, managedBy: null });
    expect(buildRecordArgs(local)).not.toContain("--zero-disk-managed");
    expect(zeroDiskDeliveryEnv(local)).toBeNull();
    const plain = mkTask({ streamUpload: false, managedBy: "hub", zeroDiskDelivery: DELIVERY });
    expect(buildRecordArgs(plain)).not.toContain("--zero-disk-managed");
    expect(zeroDiskDeliveryEnv(plain)).toBeNull();
  });
  it("a managed task without a delivery still gets the flag (so the child refuses) but no env", () => {
    const t = mkTask({ streamUpload: true, managedBy: "hub", zeroDiskDelivery: null });
    expect(buildRecordArgs(t)).toContain("--zero-disk-managed");
    expect(zeroDiskDeliveryEnv(t)).toBeNull();
  });
  it("the delivery never appears in argv (only in env)", () => {
    const argv = buildRecordArgs(mkTask({ streamUpload: true, managedBy: "hub", zeroDiskDelivery: DELIVERY })).join(" ");
    expect(argv).not.toContain("bilibili:1");
  });
});

describe("TaskManager refuses a managed zero-disk task before spawning", () => {
  let store: TaskStore;
  let spawner: MockSpawner;
  // The default preflight writes a status file under the data root: keep it out of the repo cwd.
  const prevRoot = process.env.DOUYIN_REC_ROOT;
  let root: string;
  beforeEach(() => {
    store = new TaskStore(":memory:");
    spawner = new MockSpawner();
    root = mkdtempSync(join(tmpdir(), "zd-managed-"));
    process.env.DOUYIN_REC_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const refuse: ZeroDiskPreflight = { ok: false, refusal: { code: "account_mismatch", message: "node upload account differs from the master-configured account" } };
  const accept: ZeroDiskPreflight = { ok: true, delivery: JSON.parse(DELIVERY), cookiesPath: "/x", credentialSource: "node-default" };
  const seed = (managedBy: string | null, streamUpload = true): number =>
    store.addTask({ room: "12345", streamUpload, managedBy, zeroDiskDelivery: DELIVERY }).id;

  it("refusal: no process, status error, one alert (no restart loop), reason in the task log", () => {
    const downs: string[] = [];
    const logs: string[] = [];
    const mgr = new TaskManager(store, spawner, {
      zeroDiskPreflight: () => refuse, onTaskDown: (_id, reason) => downs.push(reason), log: (m) => logs.push(m), autoRestart: true,
    });
    const id = seed("hub");
    expect(mgr.start(id)).toBe(false);
    expect(mgr.start(id)).toBe(false); // the daemon retries every tick
    expect(spawner.spawned).toHaveLength(0);
    expect(store.getTask(id)!.status).toBe("error");
    expect(downs).toHaveLength(1);
    expect(downs[0]).toContain("account_mismatch");
    expect(mgr.getLogs(id).join("\n")).toContain("account_mismatch");
  });
  it("pass: spawns normally", () => {
    const mgr = new TaskManager(store, spawner, { zeroDiskPreflight: () => accept });
    expect(mgr.start(seed("hub"))).toBe(true);
    expect(spawner.spawned).toHaveLength(1);
  });
  it("the check is not applied to master-local zero-disk or to plain recording (behavior unchanged)", () => {
    let calls = 0;
    const mgr = new TaskManager(store, spawner, { zeroDiskPreflight: () => { calls++; return refuse; } });
    expect(mgr.start(seed(null))).toBe(true);          // local zero-disk
    expect(mgr.start(seed("hub", false))).toBe(true);  // managed but not zero-disk
    expect(calls).toBe(0);
    expect(spawner.spawned).toHaveLength(2);
  });
  it("the real default check refuses a managed task that has no delivery", () => {
    const mgr = new TaskManager(store, spawner);
    const id = store.addTask({ room: "12345", streamUpload: true, managedBy: "hub" }).id;
    expect(mgr.start(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(0);
    expect(mgr.getLogs(id).join("\n")).toContain("delivery_missing");
  });
});

describe("sync + API view", () => {
  it("the delivered JSON is stored by sync but never exposed by the redacted API view", () => {
    const store = new TaskStore(":memory:");
    applyRemoteTasks(store, [{
      platform: "douyin", roomSlug: "12345", room: "12345", name: "a", quality: "origin", engine: "ffmpeg", danmu: 1,
      segmentSec: 1800, scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true, cookies: null, outDir: null,
      webhook: null, anchorName: null, rollingUpload: false, rollingEffective: false, streamUpload: true,
      zeroDiskDelivery: JSON.parse(DELIVERY),
    }]);
    const t = store.listTasks()[0]!;
    expect(t.zeroDiskDelivery).toBe(JSON.stringify(JSON.parse(DELIVERY)));
    const view = redactTaskSecrets(t) as Record<string, unknown>;
    expect("zeroDiskDelivery" in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain("bilibili:1");
  });
});
