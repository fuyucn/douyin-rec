// plan 038 T17: runNow / -N 409 rules, keyed by the suffix-free broadcast key.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { isSameBroadcast, runNowConflict } from "../../packages/orchestrator/src/run-now-guard.js";
import { ProcUnsupported, type Transport } from "../../packages/orchestrator/src/transport.js";

const BASE = "douyin:1:2026-10-17";
const fresh = (): SyncLedger => new SyncLedger(join(mkdtempSync(join(tmpdir(), "rng-")), "j.db"));
const planJson = (key: string, nodeId = "n1"): string => JSON.stringify({
  v: 1, nodeId, orderKey: key, generation: 1, prepJobId: `prep:${key}`, biliupJobId: `up:${key}`, input: {},
});
const rec = (state: ProcessReceipt["state"]): ProcessReceipt => ({ jobId: "x", state, leaseAlive: true });
const node = (procStatus: Transport["procStatus"]): Map<string, Transport> => new Map([["n1", { procStatus } as Transport]]);
const order = (l: SyncLedger, key: string, plan = true): void => { l.upsertPending(key); if (plan) l.claimUploadPlan(key, planJson(key)); };

describe("isSameBroadcast", () => {
  it("matches the base key and numeric -N suffixes only", () => {
    expect(isSameBroadcast(BASE, BASE)).toBe(true);
    expect(isSameBroadcast(`${BASE}-2`, BASE)).toBe(true);
    expect(isSameBroadcast(`${BASE}-x`, BASE)).toBe(false);
    expect(isSameBroadcast("douyin:1:2026-10-18", BASE)).toBe(false);
    expect(isSameBroadcast(`${BASE}0`, BASE)).toBe(false);
  });
});

describe("runNowConflict", () => {
  it("allows a broadcast with no BV and no queue plan", async () => {
    const l = fresh();
    order(l, BASE, false);
    expect(await runNowConflict({ ledger: l, transports: new Map() }, BASE, { force: false })).toBeNull();
  });

  it("a BV on the base key blocks the -N submission too, and force passes with a log", async () => {
    const l = fresh();
    order(l, BASE, false); l.setBv(BASE, "BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    const log = vi.fn();
    const msg = await runNowConflict({ ledger: l, transports: new Map(), log }, BASE, { force: false });
    expect(msg).toMatch(/BV1aaaaaaaaa/); // issue-guard: allow (fake BV fixture)
    expect(await runNowConflict({ ledger: l, transports: new Map(), log }, BASE, { force: true })).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("BV1aaaaaaaaa")); // issue-guard: allow (fake BV fixture)
  });

  it("a BV on a -N row blocks the base key", async () => {
    const l = fresh();
    order(l, `${BASE}-1`, false); l.setBv(`${BASE}-1`, "BV1bbbbbbbbb"); // issue-guard: allow (fake BV fixture)
    expect(await runNowConflict({ ledger: l, transports: new Map() }, BASE, { force: false })).toMatch(/-1 already has BV/);
  });

  it("another broadcast's BV does not interfere", async () => {
    const l = fresh();
    order(l, "douyin:1:2026-10-16", false); l.setBv("douyin:1:2026-10-16", "BV1ccccccccc"); // issue-guard: allow (fake BV fixture)
    expect(await runNowConflict({ ledger: l, transports: new Map() }, BASE, { force: false })).toBeNull();
  });

  it("pending, running and uncertain queue rows block; failed and cancelled do not", async () => {
    for (const state of ["pending", "running", "uncertain"] as const) {
      const l = fresh(); order(l, BASE);
      expect(await runNowConflict({ ledger: l, transports: node(async () => [rec(state)]) }, BASE, { force: false })).toMatch(state);
    }
    for (const state of ["failed", "cancelled"] as const) {
      const l = fresh(); order(l, BASE);
      expect(await runNowConflict({ ledger: l, transports: node(async () => [rec(state)]) }, BASE, { force: false })).toBeNull();
    }
  });

  it("an unreadable node (unreachable, unsupported, missing, no plan) blocks instead of passing", async () => {
    const cases: Array<[string, Map<string, Transport>, string?]> = [
      ["unreachable", node(async () => { throw new Error("ssh timeout"); })],
      ["unsupported", node(async () => { throw new ProcUnsupported("old"); })],
      ["node gone from config", new Map()],
      ["no status channel", new Map([["n1", {} as Transport]])],
    ];
    for (const [, transports] of cases) {
      const l = fresh(); order(l, BASE);
      expect(await runNowConflict({ ledger: l, transports }, BASE, { force: false })).toMatch(/queue|queued|unknown/i);
    }
    const l = fresh(); order(l, BASE, false); l.claimUploadPlan(BASE, "{not json");
    expect(await runNowConflict({ ledger: l, transports: node(async () => []) }, BASE, { force: false })).toMatch(/cannot be read/);
  });

  it("force passes an unknown queue state and logs why", async () => {
    const l = fresh(); order(l, BASE);
    const log = vi.fn();
    expect(await runNowConflict({ ledger: l, transports: node(async () => { throw new Error("x"); }), log }, BASE, { force: true })).toBeNull();
    expect(log).toHaveBeenCalledOnce();
  });
});
