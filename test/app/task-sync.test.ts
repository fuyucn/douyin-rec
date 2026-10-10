import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import type { RemoteTaskSpec } from "@drec/core";

describe("applyRemoteTasks", () => {
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
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-sync-"));
    store = new TaskStore(join(dir, "tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("远端默认:已存在任务收编为 hub 受管并更新 master 字段", () => {
    const existing = store.addTask({ room: "123456", name: "旧名" });
    const r = applyRemoteTasks(store, [spec({ name: "新名" })]);
    expect(r.applied).toEqual(["douyin:123456"]);
    const t = store.getTask(existing.id)!;
    expect(t.managedBy).toBe("hub");
    expect(t.name).toBe("新名");
  });

  // T-4:worker 录制时会自抓主播名并持久化;master 侧该值常为 null(只在建/改房间时抓一次)。
  // 若下发时带 `anchorName: null`,会把 worker 抓到的正确值覆盖成空 → 界面主播名消失。
  it("T-4: 更新已有任务时不下发 anchorName(null 不覆盖 worker 自抓的值)", () => {
    const existing = store.addTask({ room: "123456", name: "旧名" });
    store.setAnchorName(existing.id, "worker 抓到的名");   // 模拟 worker 录制时自抓
    applyRemoteTasks(store, [spec({ anchorName: null })]);
    expect(store.getTask(existing.id)!.anchorName).toBe("worker 抓到的名");   // 未被 null 覆盖
  });
  it("T-4: 新建受管任务预置 master 的 anchorName(非 null)", () => {
    applyRemoteTasks(store, [spec({ anchorName: "master 侧的名字" })]);
    const t = store.listTasks().find((x) => x.room.includes("123456"))!;
    expect(t.anchorName).toBe("master 侧的名字");   // 预置,避免 Waiting 阶段显示房间号
  });
  it("T-4: 新建受管任务 anchorName 为 null 时不出错", () => {
    applyRemoteTasks(store, [spec({ anchorName: null })]);
    const t = store.listTasks().find((x) => x.room.includes("123456"))!;
    expect(t.anchorName).toBeNull();
  });

  // 注意:期望为空现在会被 empty-desired 守卫拦下(T-2),删除语义用「期望非空但不含它」来测。
  it("远端默认:不在期望列表的受管任务被删除", () => {
    const doomed = store.addTask({ room: "555", managedBy: "hub" });
    const keep = spec({ roomSlug: "123456", room: "https://live.douyin.com/123456" });
    const r = applyRemoteTasks(store, [keep]);
    expect(r.removed).toEqual(["douyin:555"]);
    expect(store.getTask(doomed.id)).toBeNull();
  });

  it("期望任务已禁用但仍在运行:置 pending 硬停而不是等排空", () => {
    const live = store.addTask({ room: "123456", managedBy: "hub" });
    store.setStatus(live.id, "draining");
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.pending).toEqual(["douyin:123456"]);
    const t = store.getTask(live.id)!;
    expect(t.enabled).toBe(false);
    expect(t.status).toBe("draining"); // 硬停由 _apply-tasks / master manager 执行
  });

  it("期望任务已禁用且已停止:不再进 pending(避免每轮重复硬停)", () => {
    const done = store.addTask({ room: "123456", managedBy: "hub" });
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.pending).toEqual([]);
    expect(store.getTask(done.id)!.enabled).toBe(false);
  });

  it("master 本地(adopt=false):已有源任务保持可编辑,历史 hub 标记被清掉", () => {
    const src = store.addTask({ room: "123456", name: "一勺小苏打", managedBy: "hub" });
    const r = applyRemoteTasks(store, [spec({ name: "一勺小苏打" })], undefined, { adopt: false });
    expect(r.applied).toEqual(["douyin:123456"]);
    const t = store.getTask(src.id)!;
    expect(t.managedBy).toBeNull();
    expect(t.name).toBe("一勺小苏打");
  });

  it("master 本地(adopt=false):不在期望列表的本机任务不会被 hub 删除", () => {
    const local = store.addTask({ room: "999" });
    applyRemoteTasks(store, [spec()], undefined, { adopt: false });
    expect(store.getTask(local.id)).not.toBeNull();
  });

  it("master 本地(adopt=false):新建任务不标 hub 受管", () => {
    const r = applyRemoteTasks(store, [spec({ roomSlug: "777", room: "https://live.douyin.com/777" })], undefined, { adopt: false });
    expect(r.applied).toEqual(["douyin:777"]);
    const tasks = store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].managedBy).toBeNull();
  });

  // ── T-2 期望骤减安全阀(plans/030)────────────────────────────────────────────────
  describe("T-2 骤减守卫", () => {
    /** 造 n 个 enabled 的 hub 受管任务(store.addTask 默认 enabled=false,必须显式开)。 */
    const seed = (n: number, prefix = "9"): number[] =>
      Array.from({ length: n }, (_, i) =>
        store.addTask({ room: `${prefix}${i}`, managedBy: "hub", enabled: true }).id);

    it("空期望 + 本地有受管任务:整轮拒发,一个都不删(rejected=empty-desired)", () => {
      seed(3);
      const r = applyRemoteTasks(store, []);
      expect(r.rejected).toBe("empty-desired");
      expect(r.removed).toEqual([]);
      expect(r.applied).toEqual([]);
      expect(store.listTasks()).toHaveLength(3);
      // 受管任务不该被顺手停用——守卫是「什么都不做」,不是「先停再说」。
      expect(store.listTasks().every((t) => t.enabled)).toBe(true);
    });

    it("空期望 + 本地无受管任务:正常返回(全新节点首轮不该被拦)", () => {
      const r = applyRemoteTasks(store, []);
      expect(r.rejected).toBeUndefined();
      expect(r.removed).toEqual([]);
    });

    it("空期望但受管任务全是 disabled:仍然拒发(totalManaged 口径含停用)", () => {
      const ids = seed(2);
      for (const id of ids) store.setEnabled(id, false);
      const r = applyRemoteTasks(store, []);
      expect(r.rejected).toBe("empty-desired");
      expect(store.listTasks()).toHaveLength(2);
    });

    it("骤减(4→1):只停用不删除,且停用的期望内任务照常应用", () => {
      const ids = seed(4);
      const r = applyRemoteTasks(store, [spec()], undefined, { adopt: true });
      expect(r.rejected).toBe("mass-shrink");
      expect(r.removed).toEqual([]);
      for (const id of ids) expect(store.getTask(id)!.enabled).toBe(false);
      expect(r.applied).toEqual(["douyin:123456"]);
    });

    it("骤减时已在录的任务进 pending(供上层硬停),纯停用的不进", () => {
      const ids = seed(4);
      store.setStatus(ids[0], "running");
      const r = applyRemoteTasks(store, [spec()], undefined, { adopt: true });
      // 骤减走「只停用」通道,pending = 所有被停用的受管任务(上层据此硬停,语义同两阶段删除)
      expect(r.pending.sort()).toEqual(["douyin:90", "douyin:91", "douyin:92", "douyin:93"]);
    });

    // 计划定稿口径:2→1 也算骤减(最常见于「master 只读到部分规则」)。不卡死:
    // 本轮只停用,下一轮 enabledManaged=1 → 守卫放行 → 真删。
    it("边界 totalManaged=2 → 期望 1:本轮只停用,下一轮真删(收敛,不卡死)", () => {
      const ids = seed(2);          // 房间 "90"(留在期望)与 "91"(被移出)
      const doomed = ids[1];
      const r = applyRemoteTasks(store, [spec({ roomSlug: "90", room: "https://live.douyin.com/90" })], undefined, { adopt: true });
      expect(r.rejected).toBe("mass-shrink");
      expect(r.removed).toEqual([]);
      expect(r.applied).toEqual(["douyin:90"]);
      expect(store.getTask(doomed)!.enabled).toBe(false);
      // 下一轮:enabledManaged 降到 1 → 不再是骤减 → 走两阶段删除并真删
      const r2 = applyRemoteTasks(store, [spec({ roomSlug: "90", room: "https://live.douyin.com/90" })], undefined, { adopt: true });
      expect(r2.rejected).toBeUndefined();
      expect(r2.removed).toEqual(["douyin:91"]);
      expect(store.getTask(doomed)).toBeNull();
    });

    it("force=true:空期望照常执行删除(合法清空,如房间改派到别的节点)", () => {
      const doomed = store.addTask({ room: "555", managedBy: "hub" });
      const r = applyRemoteTasks(store, [], undefined, { force: true });
      expect(r.rejected).toBeUndefined();
      expect(r.removed).toEqual(["douyin:555"]);
      expect(store.getTask(doomed.id)).toBeNull();
    });

    it("force=true:骤减照常执行删除", () => {
      seed(4);
      const r = applyRemoteTasks(store, [spec()], undefined, { adopt: true, force: true });
      expect(r.rejected).toBeUndefined();
      // 两阶段删除:仍在 enabled 的先停用,所以本轮 removed=0,下一轮才真删。
      expect(r.removed).toEqual([]);
      expect(r.pending.sort()).toEqual(["douyin:90", "douyin:91", "douyin:92", "douyin:93"]);
    });

    it("DREC_ALLOW_SHRINK=1 等价于 force(env 逃生门)", () => {
      process.env.DREC_ALLOW_SHRINK = "1";
      try {
        const doomed = store.addTask({ room: "555", managedBy: "hub" });
        const r = applyRemoteTasks(store, []);
        expect(r.rejected).toBeUndefined();
        expect(r.removed).toEqual(["douyin:555"]);
        expect(store.getTask(doomed.id)).toBeNull();
      } finally {
        delete process.env.DREC_ALLOW_SHRINK;
      }
    });

    it("骤减被拦时也写审计快照(便于 UI 显示 master 真实期望)", () => {
      seed(4);
      const msDir = join(dir, "managed-state");
      applyRemoteTasks(store, [spec()], undefined, { adopt: true, managedStateDir: msDir, expectedVersion: 7 });
      expect(readFileSync(join(msDir, "rooms.json"), "utf8")).toContain("123456");
    });

    it("空期望被拒时**不**写快照(快照必须等于真正下发过的期望)", () => {
      seed(2);
      const msDir = join(dir, "managed-state");
      applyRemoteTasks(store, [], undefined, { managedStateDir: msDir });
      expect(existsSync(join(msDir, "rooms.json"))).toBe(false);
    });

    it("master 本地(adopt=false):期望骤减不牵连本机非受管任务", () => {
      const local = store.addTask({ room: "888", enabled: true });           // 非受管
      const ids = seed(4);
      const r = applyRemoteTasks(store, [spec()], undefined, { adopt: false });
      expect(r.rejected).toBe("mass-shrink");
      expect(store.getTask(local.id)!.enabled).toBe(true);   // 本机任务不归 hub 管
      for (const id of ids) expect(store.getTask(id)!.enabled).toBe(false);
    });
  });
});

// ── T3 删除语义收敛:禁用 ≠ 删除 ──────────────────────────────────────────────────
describe("T3 删除语义", () => {
  let dir: string;
  let store: TaskStore;
  const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
    platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456",
    name: "主播A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
    scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
    cookies: null, outDir: null, webhook: null, anchorName: null, ...over,
  });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "t3-")); store = new TaskStore(join(dir, "tasks.db")); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("期望含 enabled:false → 停用但保留,不是删除", () => {
    const t = store.addTask({ room: "123456", managedBy: "hub", enabled: true });
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.removed).toEqual([]);
    expect(r.applied).toEqual(["douyin:123456"]);
    expect(store.getTask(t.id)!.enabled).toBe(false);   // 停用
    expect(store.getTask(t.id)).not.toBeNull();          // 但保留
  });

  it("enabled:false 且本节点从未有过该房间 → 不新建幽灵任务", () => {
    const r = applyRemoteTasks(store, [spec({ enabled: false })]);
    expect(r.applied).toEqual([]);
    expect(store.listTasks()).toHaveLength(0);
  });

  it("enabled:false 不触发骤减守卫的删除语义(停用保留,任务仍在)", () => {
    for (const s of ["1", "2", "3", "4"]) store.addTask({ room: s, managedBy: "hub", enabled: true });
    const keep = spec({ roomSlug: "1", room: "https://live.douyin.com/1" });
    const off = spec({ roomSlug: "2", room: "https://live.douyin.com/2", enabled: false });
    applyRemoteTasks(store, [keep, off], undefined, { adopt: true });
    expect(store.listTasks()).toHaveLength(4);          // 一个都没删
    expect(store.listTasks().filter((t) => t.enabled)).toHaveLength(1);
  });

  it("缺席(规则消失)→ 两阶段删除:第 1 轮停用、第 2 轮真删", () => {
    const a = store.addTask({ room: "555", managedBy: "hub", enabled: true });
    const keep = spec({ roomSlug: "90", room: "https://live.douyin.com/90" });
    const r1 = applyRemoteTasks(store, [keep], undefined, { adopt: true });
    expect(r1.removed).toEqual([]);
    expect(store.getTask(a.id)!.enabled).toBe(false);     // 第 1 轮:只停用
    const r2 = applyRemoteTasks(store, [keep], undefined, { adopt: true });
    expect(r2.removed).toEqual(["douyin:555"]);          // 第 2 轮:真删
    expect(store.getTask(a.id)).toBeNull();
  });

  it("DREC_EXPLICIT_DELETE 默认关 → deleted:true 被忽略(仍走两阶段)", () => {
    const a = store.addTask({ room: "555", managedBy: "hub", enabled: true });
    const keep = spec({ roomSlug: "90", room: "https://live.douyin.com/90" });
    const hinted = spec({ roomSlug: "555", room: "https://live.douyin.com/555", deleted: true, enabled: true });
    const r1 = applyRemoteTasks(store, [keep, hinted], undefined, { adopt: true });
    expect(r1.removed).toEqual([]);                       // 提示被忽略
    expect(store.getTask(a.id)!.enabled).toBe(false);
    expect(store.getTask(a.id)).not.toBeNull();
  });

  it("DREC_EXPLICIT_DELETE=1 → deleted:true 跳过第 1 轮直接删,且不会先复活", () => {
    process.env.DREC_EXPLICIT_DELETE = "1";
    try {
      const a = store.addTask({ room: "555", managedBy: "hub", enabled: true });
      const keep = spec({ roomSlug: "90", room: "https://live.douyin.com/90" });
      const hinted = spec({ roomSlug: "555", room: "https://live.douyin.com/555", deleted: true, enabled: true });
      const r = applyRemoteTasks(store, [keep, hinted], undefined, { adopt: true });
      expect(r.removed).toEqual(["douyin:555"]);          // 直接删
      expect(store.getTask(a.id)).toBeNull();
      // 关键:不能被 upsert 先「复活」再删(applied 里不该出现它)
      expect(r.applied).toEqual(["douyin:90"]);
    } finally {
      delete process.env.DREC_EXPLICIT_DELETE;
    }
  });

  it("deleted:true + 骤减 → 守卫不把它当「缺席」反复 disableOnly(开关语义自洽)", () => {
    process.env.DREC_EXPLICIT_DELETE = "1";
    try {
      for (const s of ["1", "2", "3", "4"]) store.addTask({ room: s, managedBy: "hub", enabled: true });
      const keep = spec({ roomSlug: "1", room: "https://live.douyin.com/1" });
      const hinted = spec({ roomSlug: "4", room: "https://live.douyin.com/4", deleted: true, enabled: true });
      const r = applyRemoteTasks(store, [keep, hinted], undefined, { adopt: true });
      // 显式删除是比骤减更强的意图:该删的直接删,不该被守卫拦成「只停用」
      expect(r.removed).toEqual(["douyin:4"]);
    } finally {
      delete process.env.DREC_EXPLICIT_DELETE;
    }
  });

  it("force → 缺席的房间照常两阶段删除(合法缩容不受 deleted 开关影响)", () => {
    const a = store.addTask({ room: "555", managedBy: "hub", enabled: true });
    const r1 = applyRemoteTasks(store, [], undefined, { force: true });
    expect(r1.removed).toEqual([]);
    expect(store.getTask(a.id)!.enabled).toBe(false);
    const r2 = applyRemoteTasks(store, [], undefined, { force: true });
    expect(r2.removed).toEqual(["douyin:555"]);
  });
});
