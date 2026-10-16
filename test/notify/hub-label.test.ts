import { describe, expect, it } from "vitest";
import type { NotifyEvent } from "@drec/core";
import { formatMessage } from "../../packages/observability/src/notifier/index.js";
import { enrichHubEvent, humanizeStreamKeys, parseStreamKey, type HubLabelLookup } from "../../packages/observability/src/notifier/hub-label.js";

const lookup: HubLabelLookup = {
  anchorOf: (p, slug) => (p === "douyin" && slug === "100001" ? "主播A" : undefined),
  workerName: (id) => (id === "w-test-1" ? "node-a" : undefined),
};

describe("parseStreamKey", () => {
  it("plain and same-day suffixed keys", () => {
    expect(parseStreamKey("douyin:100001:2026-10-16")).toEqual({ platform: "douyin", roomSlug: "100001", date: "2026-10-16" });
    expect(parseStreamKey("bilibili:123:2026-10-16_2130")).toEqual({ platform: "bilibili", roomSlug: "123", date: "2026-10-16", time: "21:30" });
  });
  it("rejects non stream keys", () => {
    expect(parseStreamKey("hello")).toBeNull();
    expect(parseStreamKey("douyin:1")).toBeNull();
  });
});

describe("enrichHubEvent + formatMessage", () => {
  const start: NotifyEvent = { kind: "hubTaskStart", streamKey: "douyin:100001:2026-10-16", room: "100001", workers: ["w-test-1"], mode: "upload" };

  it("hubTaskStart names the anchor, date and node", () => {
    const msg = formatMessage(enrichHubEvent(start, lookup));
    expect(msg).toBe("📋 Hub 任务开始：主播A · 2026-10-16（房间 100001，1 个节点：node-a）· 上传");
  });
  it("unknown anchor / node degrade to room number and worker id, never blank", () => {
    const e = enrichHubEvent({ ...start, room: "999", streamKey: "douyin:999:2026-10-16", workers: ["w1"] }, lookup);
    const msg = formatMessage(e);
    expect(msg).toContain("999");
    expect(msg).toContain("2026-10-16");
    expect(msg).toContain("w1");
  });
  it("un-enriched legacy event keeps the old wording", () => {
    expect(formatMessage(start)).toBe("📋 Hub 任务开始：100001（1 个节点：w-test-1）· 上传");
  });
  it("stageReady / uploadDone carry anchor and date; non-hub uploadDone untouched", () => {
    expect(formatMessage(enrichHubEvent({ kind: "stageReady", streamKey: "douyin:100001:2026-10-16" }, lookup))).toContain("主播A · 2026-10-16");
    const up = formatMessage(enrichHubEvent({ kind: "uploadDone", bv: "BV1x", url: "u", streamKey: "douyin:100001:2026-10-16" }, lookup));
    expect(up).toContain("主播A · 2026-10-16");
    expect(up).toContain("BV1x");
    const plain: NotifyEvent = { kind: "uploadDone", bv: "BV1x", url: "u" };
    expect(enrichHubEvent(plain, lookup)).toBe(plain);
  });
  it("error messages get embedded stream keys rewritten", () => {
    const e = enrichHubEvent({ kind: "error", stage: "同步", message: "douyin:100001:2026-10-16 上传重试 3 次仍失败" }, lookup);
    expect(e).toMatchObject({ message: "主播A · 2026-10-16 上传重试 3 次仍失败" });
    expect(humanizeStreamKeys("no key here", lookup)).toBe("no key here");
  });
  it("embedded keys: prefixed keys still rewritten; URLs and glued digits left alone", () => {
    expect(humanizeStreamKeys("stage:douyin:100001:2026-10-16 x", lookup)).toBe("stage:主播A · 2026-10-16 x");
    expect(humanizeStreamKeys("http://host:8080/x:2026-10-16", lookup)).toBe("http://host:8080/x:2026-10-16");
    expect(humanizeStreamKeys("douyin:100001:2026-10-16_21300", lookup)).toBe("主播A · 2026-10-16_21300");
  });
});
