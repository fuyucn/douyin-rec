import { describe, expect, it } from "vitest";
import type { NodeCapabilities, ZeroDiskReceipt, ZeroDiskReport } from "@drec/core";
import { ZeroDiskFleet, UNSUPPORTED_REASON, blockedKey, type ZeroDiskWorker } from "./zero-disk-fleet.js";
import type { Transport } from "./transport.js";

const receipt = (over: Partial<ZeroDiskReceipt> = {}): ZeroDiskReceipt => ({
  v: 1, id: "douyin:1:100", platform: "douyin", roomSlug: "1", streamKey: "douyin:1:2026-10-20", bvid: "BVfake1", parts: 2, atMs: 100, ...over,
});
const report = (over: Partial<ZeroDiskReport> = {}): ZeroDiskReport => ({ v: 1, receipts: [], status: [], ...over });

interface FakeNode {
  caps: () => Promise<NodeCapabilities>;
  report: () => Promise<ZeroDiskReport | null>;
  capCalls: number;
  reportCalls: number;
}
function node(o: { zeroDisk?: boolean; capsThrow?: boolean; report?: () => Promise<ZeroDiskReport | null> } = {}): { w: ZeroDiskWorker; n: FakeNode } {
  const n: FakeNode = {
    capCalls: 0, reportCalls: 0,
    caps: async () => { n.capCalls++; if (o.capsThrow) throw new Error("ssh timeout"); return { biliup: true, cookies: true, diskFreeGB: 1, ...(o.zeroDisk ? { zeroDisk: true } : {}) }; },
    report: async () => { n.reportCalls++; return (o.report ?? (async () => report()))(); },
  };
  const transport = { id: "vps1", nodeCapabilities: n.caps, zeroDiskReport: n.report } as unknown as Transport;
  return { w: { id: "vps1", name: "Node 1", kind: "ssh", transport }, n };
}

function fleet(applied: ZeroDiskReceipt[] = [], opts: { fail?: () => boolean; clock?: { t: number } } = {}) {
  const alerts: string[] = [];
  const clock = opts.clock ?? { t: 1_000_000 };
  const f = new ZeroDiskFleet({
    applyReceipt: (r) => {
      if (opts.fail?.()) return { ok: false, error: "db locked" };
      applied.push(r);
      return { ok: true };
    },
    alert: (m) => alerts.push(m),
    now: () => clock.t,
  });
  return { f, alerts, clock };
}

describe("capability gate", () => {
  it("fails closed: never-probed, old (no field) and unreachable nodes are not pushed to", async () => {
    const { f } = fleet();
    expect(f.allowsPush("vps1")).toBe(false); // never probed
    const old = node({ zeroDisk: false });
    await f.refreshSupport([old.w]);
    expect(f.allowsPush("vps1")).toBe(false);
    expect(f.support("vps1")).toMatchObject({ kind: "unsupported", reason: UNSUPPORTED_REASON });
    const dead = node({ capsThrow: true });
    const g = fleet().f;
    await g.refreshSupport([dead.w]);
    expect(g.allowsPush("vps1")).toBe(false);
    expect(g.support("vps1")?.kind).toBe("unknown");
  });
  it("a node that advertises zero-disk is allowed; the master's local worker is never probed", async () => {
    const { f } = fleet();
    const ok = node({ zeroDisk: true });
    await f.refreshSupport([ok.w, { id: "local", name: "local", kind: "local", transport: ok.w.transport }]);
    expect(f.allowsPush("vps1")).toBe(true);
    expect(f.support("local")).toBeUndefined();
    expect(ok.n.capCalls).toBe(1);
  });
  it("a supported answer is cached; an unsupported node is re-probed quickly so an upgrade is noticed", async () => {
    const { f, clock } = fleet();
    const ok = node({ zeroDisk: true });
    await f.refreshSupport([ok.w]);
    clock.t += 30_000;
    await f.refreshSupport([ok.w]);
    expect(ok.n.capCalls).toBe(1); // still cached
    const old = node({ zeroDisk: false });
    const g = fleet();
    await g.f.refreshSupport([old.w]);
    g.clock.t += 61_000;
    await g.f.refreshSupport([old.w]);
    expect(old.n.capCalls).toBe(2); // retried after the short ttl
  });
});

describe("a transient probe failure must not stop a live upload", () => {
  it("a known-supported node keeps its status when a re-probe fails (revoked only by an explicit answer)", async () => {
    const { f, clock } = fleet();
    let mode: "ok" | "throw" | "old" = "ok";
    const n = node({ zeroDisk: true });
    const w: ZeroDiskWorker = {
      ...n.w,
      transport: {
        id: "vps1",
        nodeCapabilities: async () => {
          if (mode === "throw") throw new Error("ssh timeout");
          return { biliup: true, cookies: true, diskFreeGB: 1, ...(mode === "ok" ? { zeroDisk: true } : {}) };
        },
      } as unknown as Transport,
    };
    await f.refreshSupport([w]);
    expect(f.allowsPush("vps1")).toBe(true);
    mode = "throw";
    clock.t += 6 * 60_000; // past the supported ttl: re-probed, and the probe fails
    await f.refreshSupport([w]);
    expect(f.allowsPush("vps1")).toBe(true); // kept
    mode = "old";
    clock.t += 6 * 60_000;
    await f.refreshSupport([w]);
    expect(f.allowsPush("vps1")).toBe(false); // an explicit "no" does revoke
  });
  it("a never-probed node gets one immediate retry before being treated as unknown", async () => {
    const { f } = fleet();
    let calls = 0;
    const w: ZeroDiskWorker = {
      id: "vps1", name: "Node 1", kind: "ssh",
      transport: { id: "vps1", nodeCapabilities: async () => { calls++; if (calls === 1) throw new Error("blip"); return { biliup: true, cookies: true, diskFreeGB: 1, zeroDisk: true }; } } as unknown as Transport,
    };
    await f.refreshSupport([w]);
    expect(calls).toBe(2);
    expect(f.allowsPush("vps1")).toBe(true);
    const dead: ZeroDiskWorker = { ...w, transport: { id: "vps1", nodeCapabilities: async () => { throw new Error("down"); } } as unknown as Transport };
    const g = fleet().f;
    await g.refreshSupport([dead]);
    expect(g.allowsPush("vps1")).toBe(false);
    expect(g.support("vps1")?.kind).toBe("unknown");
  });
});

describe("receipts: master writes the ledger exactly once", () => {
  it("applies each receipt once across repeated polls (the node never deletes its receipts)", async () => {
    const applied: ZeroDiskReceipt[] = [];
    const { f } = fleet(applied);
    const n = node({ zeroDisk: true, report: async () => report({ receipts: [receipt()] }) });
    for (let i = 0; i < 3; i++) await f.poll([n.w], new Set(["vps1"]));
    expect(applied).toHaveLength(1);
    expect(n.n.reportCalls).toBe(3);
  });
  it("a master that was offline catches up: receipts written meanwhile are all applied on reconnect", async () => {
    const applied: ZeroDiskReceipt[] = [];
    const { f } = fleet(applied);
    // node accumulated three runs while the master was away
    const all = [receipt({ id: "a", atMs: 1 }), receipt({ id: "b", atMs: 2 }), receipt({ id: "c", atMs: 3 })];
    const n = node({ zeroDisk: true, report: async () => report({ receipts: all }) });
    await f.poll([n.w], new Set(["vps1"]));
    expect(applied.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("a failed ledger write is retried next poll (not marked applied) and alerts once", async () => {
    const applied: ZeroDiskReceipt[] = [];
    let failing = true;
    const { f, alerts } = fleet(applied, { fail: () => failing });
    const n = node({ zeroDisk: true, report: async () => report({ receipts: [receipt()] }) });
    await f.poll([n.w], new Set(["vps1"]));
    await f.poll([n.w], new Set(["vps1"]));
    expect(applied).toHaveLength(0);
    expect(alerts).toHaveLength(1); // once, not per poll
    failing = false;
    await f.poll([n.w], new Set(["vps1"]));
    expect(applied).toHaveLength(1);
  });
  it("an applyReceipt that throws is treated as a failure, not a crash of the poll", async () => {
    const f = new ZeroDiskFleet({ applyReceipt: () => { throw new Error("boom"); } });
    const n = node({ zeroDisk: true, report: async () => report({ receipts: [receipt()] }) });
    await expect(f.poll([n.w], new Set(["vps1"]))).resolves.toBeUndefined();
  });
  it("an unreachable node is offline, never read as 'no receipts'; nothing is applied", async () => {
    const applied: ZeroDiskReceipt[] = [];
    const { f } = fleet(applied);
    const n = node({ zeroDisk: true, report: async () => { throw new Error("ssh rc=255"); } });
    await f.poll([n.w], new Set(["vps1"]));
    expect(applied).toHaveLength(0);
    expect(f.view(n.w, { platform: "douyin", roomSlug: "1" })).toMatchObject({ state: "offline" });
  });
  it("an old node (unknown command → null) is 'unsupported', not an error, and closes the gate", async () => {
    const { f } = fleet();
    const n = node({ zeroDisk: true, report: async () => null });
    await f.refreshSupport([n.w]);
    expect(f.allowsPush("vps1")).toBe(true);
    await f.poll([n.w], new Set(["vps1"]));
    expect(f.allowsPush("vps1")).toBe(false); // the node rolled back to an old bundle
    expect(f.view(n.w, { platform: "douyin", roomSlug: "1" })).toMatchObject({ state: "unsupported" });
  });
  it("nodes without a zero-disk room are polled only on the slow idle cadence; the local worker never", async () => {
    const { f, clock } = fleet();
    const n = node({ zeroDisk: true });
    const local = node({ zeroDisk: true });
    const lw: ZeroDiskWorker = { ...local.w, id: "local", kind: "local" };
    await f.poll([n.w, lw], new Set());
    expect(n.n.reportCalls).toBe(1);
    await f.poll([n.w, lw], new Set());
    expect(n.n.reportCalls).toBe(1); // idle: skipped
    clock.t += 11 * 60_000;
    await f.poll([n.w, lw], new Set());
    expect(n.n.reportCalls).toBe(2);
    expect(local.n.reportCalls).toBe(0);
  });
});

describe("console view", () => {
  const room = { platform: "douyin", roomSlug: "1" };
  it("reports node-side status: running parts, a refusal reason code, and the blocked reason has precedence", async () => {
    const { f } = fleet();
    const status = [
      { v: 1 as const, platform: "douyin", roomSlug: "1", state: "refused" as const, code: "account_mismatch" as const, message: "m", parts: 0, updatedAt: 5 },
      { v: 1 as const, platform: "douyin", roomSlug: "2", state: "running" as const, parts: 4, bvid: "BVx", updatedAt: 5 },
    ];
    const n = node({ zeroDisk: true, report: async () => report({ status }) });
    await f.refreshSupport([n.w]);
    await f.poll([n.w], new Set(["vps1"]));
    expect(f.view(n.w, room)).toMatchObject({ state: "ok", run: "refused", code: "account_mismatch" });
    expect(f.view(n.w, { platform: "douyin", roomSlug: "2" })).toMatchObject({ state: "ok", run: "running", parts: 4, bvid: "BVx" });
    expect(f.view(n.w, { platform: "douyin", roomSlug: "3" })).toMatchObject({ state: "ok" });
    expect(f.view(n.w, room, "master account unknown")).toMatchObject({ state: "blocked", reason: "master account unknown" });
  });
  it("an old / unconfirmed node is shown with the reason, even before any poll", async () => {
    const { f } = fleet();
    const old = node({ zeroDisk: false });
    await f.refreshSupport([old.w]);
    expect(f.view(old.w, room)).toMatchObject({ state: "unsupported", reason: UNSUPPORTED_REASON });
    const dead = node({ capsThrow: true });
    const g = fleet().f;
    await g.refreshSupport([dead.w]);
    expect(g.view(dead.w, room)).toMatchObject({ state: "offline" });
  });
  it("attaches the compact live summary from report.live", async () => {
    const { f } = fleet();
    const n = node({ zeroDisk: true, report: async () => report({
      status: [{ v: 1, platform: "douyin", roomSlug: "1", state: "running", parts: 1, updatedAt: 10 }],
      live: [{
        platform: "douyin", roomSlug: "1",
        current: {
          schemaVersion: 1, mode: "zero-disk", sessionId: "douyin:1:10", createdAt: 10,
          platform: "douyin", roomSlug: "1", state: "streaming", startedAt: 10, updatedAt: 10,
          currentPart: { index: 0, phase: "streaming", uploadedBytes: 50, chunks: 1 },
          parts: [{ index: 0, phase: "streaming", uploadedBytes: 50, chunks: 1 }], events: [],
        },
      }],
    }) });
    await f.refreshSupport([n.w]);
    await f.poll([n.w], new Set(["vps1"]));
    expect(f.view(n.w, room)).toMatchObject({
      state: "ok", live: { state: "streaming", partsConfirmed: 0, currentPart: { uploadedBytes: 50 } },
    });
  });
  it("snapshot groups per room and carries blocked reasons by (worker, room)", async () => {
    const { f } = fleet();
    const n = node({ zeroDisk: true });
    await f.refreshSupport([n.w]);
    const snap = f.snapshot(
      [{ workerId: "vps1", platform: "douyin", roomSlug: "1" }, { workerId: "vps1", platform: "douyin", roomSlug: "2" }, { workerId: "gone", platform: "douyin", roomSlug: "9" }],
      [n.w],
      new Map([[blockedKey("vps1", "douyin", "2"), "no account"]]),
    );
    expect(snap.get("douyin:1")).toHaveLength(1);
    expect(snap.get("douyin:2")![0]).toMatchObject({ state: "blocked", reason: "no account" });
    expect(snap.has("douyin:9")).toBe(false); // unknown worker is dropped, not invented
  });
});
