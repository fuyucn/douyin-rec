/**
 * issue #40:rolling 开关迁到 hub 规则。覆盖 master 派生字段(rollingSpecFields / refreshLocalRollingEffective)、
 * 旧配置读取时迁移、录制端只读派生字段、旧 master/旧 worker 的兼容。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { refreshLocalRollingEffective, rollingSpecFields } from "../../packages/app/src/rolling-effective.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";
import { makeRollingUploadHookFactory } from "../../packages/app/src/rolling-upload.js";
import type { RemoteTaskSpec } from "@drec/core";

let dir: string;
let hubDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolling-eff-"));
  hubDir = join(dir, "hub");
  mkdirSync(hubDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeRule = (slug: string, rule: Record<string, unknown>): void =>
  writeFileSync(join(hubDir, `douyin.${slug}.json`), JSON.stringify(rule));

describe("rollingSpecFields — master 下发的派生字段", () => {
  it("远端:旧字段 rollingUpload 恒等于生效值(旧节点包只认它),并带 rollingEffective", () => {
    expect(rollingSpecFields({ mode: "rolling", workers: ["vps2"] }, false, false)).toEqual({ rollingUpload: true, rollingEffective: true });
    // 多节点:生效值 false,旧字段也必须 false(旧节点不会因旧开关 true 而各建稿)
    expect(rollingSpecFields({ mode: "rolling", workers: ["a", "b"] }, true, false)).toEqual({ rollingUpload: false, rollingEffective: false });
  });
  it("本机:旧字段透传源任务的用户旧值(不覆盖迁移来源),只更新派生字段", () => {
    expect(rollingSpecFields({ mode: "rolling", workers: ["local"] }, false, true)).toEqual({ rollingUpload: false, rollingEffective: true });
    expect(rollingSpecFields({ mode: "stage", workers: ["local"] }, true, true)).toEqual({ rollingUpload: true, rollingEffective: false });
  });
});

describe("Task.rollingEffective — 读取时迁移", () => {
  it("旧库/无派生值(NULL)→ 按旧开关迁移:true ≡ rolling,false 不开", () => {
    const s = new TaskStore(":memory:");
    expect(s.addTask({ room: "111" }).rollingEffective).toBe(false);
    expect(s.addTask({ room: "222", rollingUpload: true }).rollingEffective).toBe(true);
  });
  it("master 写入派生值后以派生值为准(不再看旧开关);null 清空 → 回落迁移", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111", rollingUpload: true });
    expect(s.updateTask(t.id, { rollingEffective: false })!.rollingEffective).toBe(false);
    expect(s.getTask(t.id)!.rollingUpload).toBe(true); // 旧列保留,不被覆盖
    expect(s.updateTask(t.id, { rollingEffective: null })!.rollingEffective).toBe(true);
  });
  it("改写旧开关(未带派生值)→ 过时的派生值被清空,回落迁移", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111", rollingUpload: true });
    s.updateTask(t.id, { rollingEffective: false });
    expect(s.updateTask(t.id, { rollingUpload: false })!.rollingEffective).toBe(false);
    s.updateTask(t.id, { rollingEffective: true });
    expect(s.updateTask(t.id, { rollingUpload: false })!.rollingEffective).toBe(false); // 不是 stale 的 true
  });
});

describe("refreshLocalRollingEffective — 启动时先用唯一判定刷新本机任务", () => {
  it("规则 mode=rolling 单节点 → true;多节点 → false(堵首轮同步前的窗口)", () => {
    const s = new TaskStore(":memory:");
    const one = s.addTask({ room: "111", rollingUpload: true });
    const many = s.addTask({ room: "222", rollingUpload: true });
    writeRule("111", { enabled: true, workers: ["local"], recording: { sourceTaskId: one.id }, pipeline: { upload: { mode: "rolling" } } });
    writeRule("222", { enabled: true, workers: ["local", "vps2"], recording: { sourceTaskId: many.id }, pipeline: { upload: { mode: "rolling" } } });
    expect(refreshLocalRollingEffective(s, hubDir)).toBe(2);
    expect(s.getTask(one.id)!.rollingEffective).toBe(true);
    // 旧开关 true 但规则多节点:改前由录制端工厂读规则拦下,现在由 master 刷新拦下
    expect(s.getTask(many.id)!.rollingEffective).toBe(false);
  });
  it("规则优先级:规则 stage 压过旧开关;规则 rolling 不需要旧开关", () => {
    const s = new TaskStore(":memory:");
    const a = s.addTask({ room: "111", rollingUpload: true });
    const b = s.addTask({ room: "222", rollingUpload: false });
    writeRule("111", { workers: ["local"], recording: { sourceTaskId: a.id }, pipeline: { upload: { mode: "stage" } } });
    writeRule("222", { workers: ["local"], recording: { sourceTaskId: b.id }, pipeline: { upload: { mode: "rolling" } } });
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(a.id)!.rollingEffective).toBe(false);
    expect(s.getTask(b.id)!.rollingEffective).toBe(true);
  });
  it("无规则的单机任务:派生值清为 NULL → 回落旧开关迁移(单机行为不变);受管任务不动", () => {
    const s = new TaskStore(":memory:");
    const solo = s.addTask({ room: "111", rollingUpload: true });
    s.updateTask(solo.id, { rollingEffective: false }); // 过时的派生值
    const managed = s.addTask({ room: "333", managedBy: "hub" });
    s.updateTask(managed.id, { rollingEffective: true });
    expect(refreshLocalRollingEffective(s, hubDir)).toBe(0);
    expect(s.getTask(solo.id)!.rollingEffective).toBe(true);
    expect(s.getTask(managed.id)!.rollingEffective).toBe(true); // master 下发值,本机不重算
  });
  it("规则绑定的房间与任务房间不一致 → 不按该规则算", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111", rollingUpload: true });
    writeRule("999", { workers: ["a", "b"], recording: { sourceTaskId: t.id }, pipeline: { upload: { mode: "rolling" } } });
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(true); // 迁移值,未被错房间的多节点规则误拦
  });
});

describe("applyRemoteTasks — 节点只存不判;旧 master 兼容", () => {
  const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
    platform: "douyin", roomSlug: "123456", room: "https://live.douyin.com/123456", name: null,
    quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800, scheduleStart: null, scheduleEnd: null,
    enabled: true, useCookie: true, cookies: null, outDir: null, webhook: null, anchorName: null,
    rollingUpload: false, ...over,
  });
  it("新 master:rollingEffective 下发并落到节点任务(更新 + 新建),与旧字段可不同", () => {
    const s = new TaskStore(":memory:");
    const ex = s.addTask({ room: "123456", rollingUpload: true });
    applyRemoteTasks(s, [spec({ rollingUpload: true, rollingEffective: false })]);
    expect(s.getTask(ex.id)!.rollingEffective).toBe(false);
    applyRemoteTasks(s, [spec({ roomSlug: "888", room: "https://live.douyin.com/888", rollingUpload: false, rollingEffective: true })], undefined, { adopt: true });
    expect(s.listTasks().find((x) => x.room.includes("888"))!.rollingEffective).toBe(true);
  });
  it("旧 master(不带 rollingEffective):回落旧字段 = 旧行为", () => {
    const s = new TaskStore(":memory:");
    applyRemoteTasks(s, [spec({ rollingUpload: true })], undefined, { adopt: true });
    expect(s.listTasks()[0].rollingEffective).toBe(true);
    applyRemoteTasks(s, [spec({ rollingUpload: false })], undefined, { adopt: true });
    expect(s.listTasks()[0].rollingEffective).toBe(false);
  });
});

describe("录制端只读派生字段", () => {
  const mk = (s: TaskStore, over: Parameters<TaskStore["addTask"]>[0]) => s.addTask(over);
  it("buildRecordArgs 只看 rollingEffective:旧开关 true 但派生 false → 不带 flag;反之带", () => {
    const s = new TaskStore(":memory:");
    const t = mk(s, { room: "111", rollingUpload: true });
    s.updateTask(t.id, { rollingEffective: false });
    expect(buildRecordArgs(s.getTask(t.id)!)).not.toContain("--rolling-upload");
    const u = mk(s, { room: "222", rollingUpload: false });
    s.updateTask(u.id, { rollingEffective: true });
    const args = buildRecordArgs(s.getTask(u.id)!);
    expect(args[args.indexOf("--rolling-upload") + 1]).toBe("1");
  });
  it("钩子工厂不再自行读 hub 规则判定:enabled=true 即使磁盘上是多节点规则也照常返回工厂", () => {
    const prev = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = dir;
    try {
      mkdirSync(join(dir, "config", "hub"), { recursive: true });
      writeFileSync(join(dir, "config", "hub", "douyin.111.json"), JSON.stringify({ workers: ["a", "b"], pipeline: { upload: { mode: "rolling" } } }));
      expect(makeRollingUploadHookFactory({ enabled: true, platform: "douyin", roomSlug: "111" })).toBeTypeOf("function");
      expect(makeRollingUploadHookFactory({ enabled: false, platform: "douyin", roomSlug: "111" })).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = prev;
    }
  });
});

describe("refreshLocalRollingEffective — 规则删除 / 解绑 / 停用后回落(issue #40 返工)", () => {
  const rollingRule = (taskId: number | null, over: Record<string, unknown> = {}) => ({
    enabled: true, workers: ["local"], recording: taskId == null ? {} : { sourceTaskId: taskId },
    pipeline: { upload: { mode: "rolling" } }, ...over,
  });
  const hasFlag = (s: TaskStore, id: number): boolean => buildRecordArgs(s.getTask(id)!).includes("--rolling-upload");

  it("规则 rolling → 删除规则文件 → 派生值回落 false,record 参数不再带 --rolling-upload", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111" });
    writeRule("111", rollingRule(t.id));
    refreshLocalRollingEffective(s, hubDir);
    expect(hasFlag(s, t.id)).toBe(true);
    unlinkSync(join(hubDir, "douyin.111.json"));
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(false);
    expect(hasFlag(s, t.id)).toBe(false);
  });
  it("规则 rolling → 解绑(sourceTaskId 清空)→ 回落 false", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111" });
    writeRule("111", rollingRule(t.id));
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(true);
    writeRule("111", rollingRule(null));
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(false);
    expect(hasFlag(s, t.id)).toBe(false);
  });
  it("规则 rolling → 停用(enabled=false)→ false;重新启用 → 恢复 true", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111" });
    writeRule("111", rollingRule(t.id, { enabled: false }));
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(false);
    expect(hasFlag(s, t.id)).toBe(false);
    writeRule("111", rollingRule(t.id));
    refreshLocalRollingEffective(s, hubDir);
    expect(s.getTask(t.id)!.rollingEffective).toBe(true);
  });
  it("规则停用时旧开关 true 也不放行", () => {
    const s = new TaskStore(":memory:");
    const t = s.addTask({ room: "111", rollingUpload: true });
    writeRule("111", rollingRule(t.id, { enabled: false }));
    refreshLocalRollingEffective(s, hubDir);
    expect(hasFlag(s, t.id)).toBe(false);
  });
  it("taskIds 只重算指定任务(起录兜底用),其它任务保持原样", () => {
    const s = new TaskStore(":memory:");
    const a = s.addTask({ room: "111" });
    const b = s.addTask({ room: "222" });
    s.updateTask(a.id, { rollingEffective: true });
    s.updateTask(b.id, { rollingEffective: true });
    refreshLocalRollingEffective(s, hubDir, [a.id]); // 无规则 → a 回落
    expect(s.getTask(a.id)!.rollingEffective).toBe(false);
    expect(s.getTask(b.id)!.rollingEffective).toBe(true);
  });
});

describe("rollingSpecFields — 停用规则下发 false", () => {
  it("enabled=false → 生效值 false,远端旧字段同为 false", () => {
    expect(rollingSpecFields({ enabled: false, mode: "rolling", workers: ["vps2"] }, true, false)).toEqual({ rollingUpload: false, rollingEffective: false });
  });
});
