// issue #73:节点任务列表「隐藏未分配受管任务」判定(纯函数,type-only import 可直测)。
import { describe, it, expect } from "vitest";
import { isUnassignedHidden } from "../../packages/web/src/lib/assigned.js";
import type { Task } from "../../packages/web/src/api/client.js";

const mk = (p: Partial<Task>): Task => ({ managedBy: "hub", assigned: false, recording: false, running: false, ...p }) as Task;

describe("isUnassignedHidden", () => {
  it("受管 ∧ assigned=false ∧ 未在录 ∧ 未运行 → 隐藏", () => {
    expect(isUnassignedHidden(mk({}))).toBe(true);
  });
  it("正在录 → 不隐藏", () => {
    expect(isUnassignedHidden(mk({ recording: true }))).toBe(false);
  });
  it("进程仍在跑(running) → 不隐藏", () => {
    expect(isUnassignedHidden(mk({ running: true }))).toBe(false);
  });
  it("assigned 缺省(旧 master) → 不隐藏", () => {
    expect(isUnassignedHidden(mk({ assigned: undefined }))).toBe(false);
  });
  it("assigned=true → 不隐藏", () => {
    expect(isUnassignedHidden(mk({ assigned: true }))).toBe(false);
  });
  it("非受管任务 → 不隐藏", () => {
    expect(isUnassignedHidden(mk({ managedBy: undefined }))).toBe(false);
    expect(isUnassignedHidden(mk({ managedBy: null as never }))).toBe(false);
  });
});
