import { describe, expect, it, vi } from "vitest";
import type { NotifyEvent } from "@drec/core";
import { enrichHubEventSafely, makeHubLabelLookup, taskDisplayName } from "../../packages/app/src/hub-label-lookup.js";

const start: NotifyEvent = { kind: "hubTaskStart", streamKey: "douyin:100001:2026-10-16", room: "100001", workers: ["w-test-1"], mode: "upload" };

describe("makeHubLabelLookup", () => {
  const tasks = [
    { id: 1, room: "100001", anchorName: "存档名", name: "任务名" },
    { id: 2, room: "100002", anchorName: null, name: "任务名B" },
  ];
  const workers = [{ id: "w-test-1", name: "node-a" }, { id: "w-test-2" }];

  it("name priority follows the shared chain (#53): task name > live name > stored anchorName", () => {
    const live = makeHubLabelLookup({ tasks: () => tasks, workers: () => workers, liveAnchor: (id) => (id === 1 ? "实时名" : null) });
    expect(live.anchorOf("douyin", "100001")).toBe("任务名");
    const unnamed = [{ id: 1, room: "100001", anchorName: "存档名", name: null }, { id: 3, room: "100003", anchorName: "存档名C", name: "  " }];
    const liveOnly = makeHubLabelLookup({ tasks: () => unnamed, workers: () => workers, liveAnchor: (id) => (id === 1 ? "实时名" : null) });
    expect(liveOnly.anchorOf("douyin", "100001")).toBe("实时名");
    expect(liveOnly.anchorOf("douyin", "100003")).toBe("存档名C"); // blank task name is skipped
  });
  it("a task with no name at all → undefined (callers keep their own room fallback)", () => {
    const l = makeHubLabelLookup({ tasks: () => [{ id: 4, room: "100004", anchorName: null, name: null }], workers: () => workers, liveAnchor: () => null });
    expect(l.anchorOf("douyin", "100004")).toBeUndefined();
  });
  it("nameSourcesOf exposes raw sources for the shared chain", () => {
    const l = makeHubLabelLookup({ tasks: () => tasks, workers: () => workers, liveAnchor: (id) => (id === 1 ? "实时名" : null) });
    expect(l.nameSourcesOf?.("douyin", "100001")).toEqual({ taskName: "任务名", liveAnchor: "实时名", cachedAnchor: "存档名" });
    expect(l.nameSourcesOf?.("douyin", "999")).toBeUndefined();
  });
  it("unknown room / other platform / unnamed worker → undefined", () => {
    const l = makeHubLabelLookup({ tasks: () => tasks, workers: () => workers, liveAnchor: () => null });
    expect(l.anchorOf("douyin", "999")).toBeUndefined();
    expect(l.anchorOf("bilibili", "100001")).toBeUndefined();
    expect(l.workerName("w-test-1")).toBe("node-a");
    expect(l.workerName("w-test-2")).toBeUndefined();
    expect(l.workerName("missing")).toBeUndefined();
  });
});

describe("enrichHubEventSafely", () => {
  it("enriches through the lookup", () => {
    const l = makeHubLabelLookup({ tasks: () => [{ id: 1, room: "100001", name: "主播A" }], workers: () => [{ id: "w-test-1", name: "node-a" }], liveAnchor: () => null });
    expect(enrichHubEventSafely(start, () => l)).toMatchObject({ anchor: "主播A", date: "2026-10-16", workerNames: ["node-a"] });
  });
  it("attaches structured ctx resolved by the shared chain", () => {
    const l = makeHubLabelLookup({ tasks: () => [{ id: 1, room: "100001", name: null, anchorName: "存档名" }], workers: () => [], liveAnchor: () => "实时名" });
    expect(enrichHubEventSafely(start, () => l).ctx).toEqual({
      name: "实时名", nameSource: "live", streamKey: "douyin:100001:2026-10-16",
      platform: "douyin", roomSlug: "100001", date: "2026-10-16",
    });
  });
  it("lookup failure → raw event + warning, never throws into the hub flow", () => {
    const warn = vi.fn();
    const out = enrichHubEventSafely(start, () => { throw new Error("db closed"); }, warn);
    expect(out).toBe(start);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db closed"));
  });
});

describe("taskDisplayName (#53 N2)", () => {
  it("task name > live > cached; nothing known → platform + room", () => {
    expect(taskDisplayName({ room: "r1", platform: "douyin", name: "T", anchorName: "C" }, "L")).toBe("T");
    expect(taskDisplayName({ room: "r1", platform: "douyin", name: null, anchorName: "C" }, "L")).toBe("L");
    expect(taskDisplayName({ room: "r1", platform: "douyin", name: null, anchorName: "C" }, null)).toBe("C");
    expect(taskDisplayName({ room: "r1", platform: "douyin", name: null, anchorName: null })).toBe("douyin r1");
  });
});
