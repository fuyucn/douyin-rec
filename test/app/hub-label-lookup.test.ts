import { describe, expect, it, vi } from "vitest";
import type { NotifyEvent } from "@drec/core";
import { enrichHubEventSafely, makeHubLabelLookup } from "../../packages/app/src/hub-label-lookup.js";

const start: NotifyEvent = { kind: "hubTaskStart", streamKey: "douyin:100001:2026-10-16", room: "100001", workers: ["w-test-1"], mode: "upload" };

describe("makeHubLabelLookup", () => {
  const tasks = [
    { id: 1, room: "100001", anchorName: "存档名", name: "任务名" },
    { id: 2, room: "100002", anchorName: null, name: "任务名B" },
  ];
  const workers = [{ id: "w-test-1", name: "node-a" }, { id: "w-test-2" }];

  it("anchor priority: live name > stored anchorName > task name", () => {
    const live = makeHubLabelLookup({ tasks: () => tasks, workers: () => workers, liveAnchor: (id) => (id === 1 ? "实时名" : null) });
    expect(live.anchorOf("douyin", "100001")).toBe("实时名");
    const stored = makeHubLabelLookup({ tasks: () => tasks, workers: () => workers, liveAnchor: () => null });
    expect(stored.anchorOf("douyin", "100001")).toBe("存档名");
    expect(stored.anchorOf("douyin", "100002")).toBe("任务名B");
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
  it("lookup failure → raw event + warning, never throws into the hub flow", () => {
    const warn = vi.fn();
    const out = enrichHubEventSafely(start, () => { throw new Error("db closed"); }, warn);
    expect(out).toBe(start);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db closed"));
  });
});
