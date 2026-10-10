// managed-state.ts —— 节点侧「上次成功应用」审计快照(T1)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManagedState, writeManagedState, clearManagedState, MANAGED_STATE_FILE } from "../../packages/app/src/managed-state.js";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import type { RemoteTaskSpec } from "@drec/core";

const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
  platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456",
  name: "主播A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
  scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
  cookies: null, outDir: null, webhook: null, anchorName: null, ...over,
});

describe("managed-state 审计快照", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "managed-state-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("write → read 得到相同 desired", () => {
    writeManagedState(dir, { version: 7, desired: [spec()] });
    const st = readManagedState(dir);
    expect(st?.version).toBe(7);
    expect(st?.desired).toHaveLength(1);
    expect(st?.desired[0]?.roomSlug).toBe("123456");
  });

  it("目录不存在 → read 返回 null(不抛)", () => {
    expect(readManagedState(join(dir, "nope"))).toBeNull();
  });

  it("内容损坏 → read 返回 null(不抛),首次运行/中断安全降级", () => {
    writeFileSync(join(dir, MANAGED_STATE_FILE), "{ 坏 json");
    expect(readManagedState(dir)).toBeNull();
    writeManagedState(dir, { version: 1, desired: [] });
    writeFileSync(join(dir, MANAGED_STATE_FILE), JSON.stringify({ version: 1 })); // 缺 desired
    expect(readManagedState(dir)).toBeNull();
  });

  it("目录不存在时 write 自动创建", () => {
    const nested = join(dir, "a", "b", "managed");
    writeManagedState(nested, { version: 1, desired: [] });
    expect(existsSync(join(nested, MANAGED_STATE_FILE))).toBe(true);
  });

  it("落盘落在**传入的目录**,不依赖 cwd/DOUYIN_REC_ROOT", () => {
    const target = join(dir, "explicit-managed");
    writeManagedState(target, { version: 3, desired: [] });
    expect(existsSync(join(target, MANAGED_STATE_FILE))).toBe(true);
    // 目录外没有残留
    expect(existsSync(join(dir, MANAGED_STATE_FILE))).toBe(false);
  });

  it("原子写:不留 .tmp 残留", () => {
    writeManagedState(dir, { version: 1, desired: [] });
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("clearManagedState 删除快照且不存在时不报错", () => {
    writeManagedState(dir, { version: 1, desired: [] });
    clearManagedState(dir);
    expect(readManagedState(dir)).toBeNull();
    expect(() => clearManagedState(dir)).not.toThrow();
  });

  it("applyRemoteTasks:不传 managedStateDir → 零副作用(既有调用点不变)", () => {
    const store = new TaskStore(join(dir, "tasks.db"));
    try {
      const r = applyRemoteTasks(store, [spec()]);
      expect(r.applied).toHaveLength(1);
      expect(existsSync(join(dir, MANAGED_STATE_FILE))).toBe(false);
    } finally { store.close(); }
  });

  it("applyRemoteTasks:传 managedStateDir → apply 成功后写入快照(内容=本轮 desired)", () => {
    const store = new TaskStore(join(dir, "tasks.db"));
    const msDir = join(dir, "config", "managed");
    try {
      const r = applyRemoteTasks(store, [spec({ roomSlug: "111" }), spec({ roomSlug: "222" })], undefined,
        { managedStateDir: msDir, expectedVersion: 42 });
      expect(r.applied).toHaveLength(2);
      const st = readManagedState(msDir);
      expect(st?.version).toBe(42);
      expect(st?.desired.map((d) => d.roomSlug).sort()).toEqual(["111", "222"]);
    } finally { store.close(); }
  });

  it("applyRemoteTasks:快照写失败不影响任务下发结果(只 warn)", () => {
    const store = new TaskStore(join(dir, "tasks.db"));
    // 用一个「是文件而非目录」的路径 → write 必失败
    const bogus = join(dir, "not-a-dir");
    writeFileSync(bogus, "x");
    const logs: string[] = [];
    try {
      const r = applyRemoteTasks(store, [spec()], (m) => logs.push(m),
        { managedStateDir: join(bogus, "managed") });
      expect(r.applied).toHaveLength(1);       // 下发照常成功
      expect(logs.some((l) => l.includes("写审计快照失败"))).toBe(true);
    } finally { store.close(); }
  });

  it("快照内容与 store 实际受管任务无关(纯审计产物,不参与删除判定)", () => {
    const store = new TaskStore(join(dir, "tasks.db"));
    const msDir = join(dir, "managed");
    try {
      // 先一轮建 4 个受管任务,再用「期望只剩 1 个」触发骤减 → 只停用不删除
      applyRemoteTasks(store, ["1", "2", "3", "4"].map((roomSlug) => spec({ roomSlug, room: `https://live.douyin.com/${roomSlug}` })),
        undefined, { managedStateDir: msDir });
      const st1 = readManagedState(msDir);
      expect(st1?.desired).toHaveLength(4);
      // 快照恒等于本轮 desired:删了 3 个期望,快照里就没有它们(与 store 里的任务行无关)
      const r = applyRemoteTasks(store, [spec({ roomSlug: "1", room: "https://live.douyin.com/1" })], undefined,
        { managedStateDir: msDir });
      expect(r.rejected).toBe("mass-shrink");
      expect(readManagedState(msDir)?.desired.map((d) => d.roomSlug)).toEqual(["1"]);
      // 守卫只停用、不删除 —— 4 个受管任务仍在(证明删除判定用的是 store 受管集,不是快照)
      const stillThere = store.listTasks().filter((t) => t.managedBy === "hub");
      expect(stillThere).toHaveLength(4);
      expect(stillThere.filter((t) => t.enabled)).toHaveLength(1);
    } finally { store.close(); }
  });
});
