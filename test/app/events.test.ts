import { describe, it, expect, vi } from "vitest";
import { EventCenter } from "../../packages/app/src/events.js";

describe("EventCenter", () => {
  it("emit 压入本地流;since 增量拉取 + 推进游标", () => {
    const ec = new EventCenter();
    ec.emit(1, { kind: "recordStart", anchor: "A", room: "r", quality: "origin" });
    ec.emit(null, { kind: "mergeDone", file: "/x/y.mp4" });
    const first = ec.since(0);
    expect(first.events.map((e) => e.event.kind)).toEqual(["recordStart", "mergeDone"]);
    expect(first.cursor).toBe(2);
    // 从游标 2 拉 → 空
    expect(ec.since(2).events).toEqual([]);
    ec.emit(1, { kind: "error", stage: "merge", message: "boom" });
    const next = ec.since(first.cursor);
    expect(next.events.map((e) => e.event.kind)).toEqual(["error"]);
  });

  it("webhook=true 触发通知器(按任务解析 webhook);webhook=false 只进本地流", () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const ec = new EventCenter({
      makeNotifier: () => ({ notify }),
      resolveWebhook: (taskId) => (taskId === 1 ? "https://hook" : undefined),
    });
    ec.emit(1, { kind: "mergeDone", file: "/a.mp4" }); // 默认 webhook
    ec.emit(1, { kind: "recordStart", anchor: "A", room: "r", quality: "o" }, { webhook: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: "mergeDone", file: "/a.mp4" });
  });

  it("环形缓冲超 max 丢最旧,游标仍单调", () => {
    const ec = new EventCenter({ max: 2 });
    ec.emit(1, { kind: "mergeDone", file: "a" });
    ec.emit(1, { kind: "mergeDone", file: "b" });
    ec.emit(1, { kind: "mergeDone", file: "c" });
    const all = ec.since(0);
    expect(all.events.map((e) => (e.event as { file: string }).file)).toEqual(["b", "c"]);
    expect(all.cursor).toBe(3);
  });

  it("initialSeq 播种:重启后 id 仍高于前端旧游标,新事件不被静默丢弃", () => {
    // 第一轮:从墙钟 1000 起,前端拉到游标 1002。
    const run1 = new EventCenter({ initialSeq: 1000 });
    run1.emit(1, { kind: "mergeDone", file: "a" });
    run1.emit(1, { kind: "mergeDone", file: "b" });
    const staleCursor = run1.since(0).cursor; // 前端记住的游标
    expect(staleCursor).toBe(1002);

    // 重启:新一轮墙钟更大(1500)。前端仍拿旧游标 1002 来拉。
    const run2 = new EventCenter({ initialSeq: 1500 });
    run2.emit(1, { kind: "error", stage: "merge", message: "boom" }); // id=1501 > 1002
    const got = run2.since(staleCursor);
    expect(got.events.map((e) => e.event.kind)).toEqual(["error"]); // 未被过滤丢弃
    expect(got.cursor).toBe(1501);
  });
});
