/**
 * Issue #331 — zero-disk on a single side node: node-side preflight, receipts/status files,
 * master-side delivery builder, spec planning, and the end-to-end "node == master rule" chain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTaskSpec } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyRemoteTasks } from "../../packages/app/src/task-sync.js";
import {
  ZERO_DISK_RECEIPT_TTL_MS,
  buildZeroDiskDelivery,
  buildZeroDiskReport,
  createZeroDiskReporter,
  makeNodeSubmitGate,
  planZeroDiskSpec,
  resolveNodeUploadCredential,
  writeZeroDiskReceipt,
  writeZeroDiskStatus,
  zeroDiskNodeDir,
  zeroDiskNodePreflight,
} from "../../packages/app/src/zero-disk-node.js";
import {
  resolveRollingUploadMeta,
  resolveStreamPartTitle,
  resolveStreamUploadMeta,
  resolveStreamUploadTitle,
} from "../../packages/app/src/rolling-upload.js";

const prevRoot = process.env.DOUYIN_REC_ROOT;
const prevCookie = process.env.BILIUP_COOKIE;
let base: string;

/** biliup cookies.json for one account (values are fake). */
const cookiesFor = (mid: string | null): string =>
  JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "fake" }, ...(mid ? [{ name: "DedeUserID", value: mid }] : [])] } });

function useRoot(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "config", "biliup"), { recursive: true });
  process.env.DOUYIN_REC_ROOT = root;
  return root;
}
const writeCookies = (root: string, mid: string | null): string => {
  const p = join(root, "config", "biliup", "cookies.json");
  writeFileSync(p, cookiesFor(mid));
  return p;
};

const GOOD = {
  v: 1,
  meta: { tid: 171, tag: "a,b", private: false },
  accountKey: "bilibili:42",
};
const json = (o: unknown): string => JSON.stringify(o);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "zd-node-"));
  delete process.env.BILIUP_COOKIE;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = prevRoot;
  if (prevCookie === undefined) delete process.env.BILIUP_COOKIE; else process.env.BILIUP_COOKIE = prevCookie;
  rmSync(base, { recursive: true, force: true });
});

describe("resolveNodeUploadCredential — node-local first, delivered path as fallback", () => {
  it("order: BILIUP_COOKIE, then node default, then the delivered path", () => {
    const have = new Set(["/env.json", "/default.json", "/delivered.json"]);
    const exists = (p: string): boolean => have.has(p);
    const o = { nodeDefaultPath: "/default.json", deliveredPath: "/delivered.json", exists };
    expect(resolveNodeUploadCredential({ ...o, env: { BILIUP_COOKIE: "/env.json" } })).toEqual({ path: "/env.json", source: "env" });
    expect(resolveNodeUploadCredential({ ...o, env: {} })).toEqual({ path: "/default.json", source: "node-default" });
    have.delete("/default.json");
    expect(resolveNodeUploadCredential({ ...o, env: {} })).toEqual({ path: "/delivered.json", source: "delivered-path" });
    have.delete("/delivered.json");
    expect(resolveNodeUploadCredential({ ...o, env: {} })).toBeNull();
  });
  it("an env path that does not exist is skipped, not trusted", () => {
    const r = resolveNodeUploadCredential({ env: { BILIUP_COOKIE: "/nope" }, nodeDefaultPath: "/d", exists: (p) => p === "/d" });
    expect(r?.source).toBe("node-default");
  });
});

describe("zeroDiskNodePreflight — refuse loudly, never default", () => {
  it("missing / unparsable / incomplete delivery → delivery_missing", () => {
    useRoot("node");
    expect(zeroDiskNodePreflight(null)).toMatchObject({ ok: false, refusal: { code: "delivery_missing" } });
    expect(zeroDiskNodePreflight("{not json")).toMatchObject({ ok: false, refusal: { code: "delivery_missing" } });
    // visibility missing → must not fall back to "private"
    const noPrivate = { ...GOOD, meta: { tid: 171, tag: "a" } };
    const r = zeroDiskNodePreflight(json(noPrivate));
    expect(r).toMatchObject({ ok: false, refusal: { code: "delivery_missing" } });
    if (!r.ok) expect(r.refusal.message).toContain("private");
  });
  it("no login file on the node → credential_missing", () => {
    useRoot("node");
    expect(zeroDiskNodePreflight(json(GOOD))).toMatchObject({ ok: false, refusal: { code: "credential_missing" } });
  });
  it("different account → account_mismatch; no key or path leaks into the message", () => {
    const root = useRoot("node");
    const p = writeCookies(root, "7");
    const r = zeroDiskNodePreflight(json(GOOD));
    expect(r).toMatchObject({ ok: false, refusal: { code: "account_mismatch" } });
    if (!r.ok) {
      expect(r.refusal.message).not.toContain("42");
      expect(r.refusal.message).not.toContain(p);
      expect(r.refusal.message).not.toContain("fake");
    }
  });
  it("a login that identifies no account cannot be verified → account_unknown", () => {
    const root = useRoot("node");
    writeCookies(root, null);
    expect(zeroDiskNodePreflight(json(GOOD))).toMatchObject({ ok: false, refusal: { code: "account_unknown" } });
  });
  it("an unreadable login file is a credential_missing refusal, not a crash", () => {
    const root = useRoot("node");
    writeCookies(root, "42");
    const r = zeroDiskNodePreflight(json(GOOD), { readFile: () => { throw new Error("EACCES"); } });
    expect(r).toMatchObject({ ok: false, refusal: { code: "credential_missing" } });
  });
  it("matching account passes and returns the verified credential path", () => {
    const root = useRoot("node");
    const p = writeCookies(root, "42");
    const r = zeroDiskNodePreflight(json(GOOD));
    expect(r).toMatchObject({ ok: true, cookiesPath: p, credentialSource: "node-default" });
  });
  it("the node's own login wins over the delivered path (and is then verified, so a wrong one is refused)", () => {
    const root = useRoot("node");
    writeCookies(root, "7"); // node default: wrong account
    const other = join(base, "other.json");
    writeFileSync(other, cookiesFor("42")); // delivered path: right account
    const r = zeroDiskNodePreflight(json({ ...GOOD, credentialPath: other }));
    expect(r).toMatchObject({ ok: false, refusal: { code: "account_mismatch" } });
  });
  it("falls back to the delivered path when the node has no login of its own", () => {
    useRoot("node"); // no cookies at the node default
    const other = join(base, "other.json");
    writeFileSync(other, cookiesFor("42"));
    const r = zeroDiskNodePreflight(json({ ...GOOD, credentialPath: other }));
    expect(r).toMatchObject({ ok: true, cookiesPath: other, credentialSource: "delivered-path" });
  });
});

describe("status + receipt files (node-written, master-polled)", () => {
  beforeEach(() => { useRoot("node"); });
  const receipt = (over: Record<string, unknown> = {}) => ({
    id: "douyin:1:1000", platform: "douyin", roomSlug: "1", streamKey: "douyin:1:2026-10-20", bvid: "BVfake1", parts: 3, atMs: 1000, ...over,
  });

  it("a receipt is written once and never overwritten (a re-run cannot change the answer)", () => {
    expect(writeZeroDiskReceipt(receipt())).toEqual({ written: true });
    expect(writeZeroDiskReceipt(receipt({ bvid: "BVother" }))).toEqual({ written: false });
    const r = buildZeroDiskReport();
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]!.bvid).toBe("BVfake1");
  });
  it("report: receipts sorted, torn/foreign files skipped, never throws on an empty node", () => {
    expect(buildZeroDiskReport()).toEqual({ v: 1, receipts: [], status: [] });
    writeZeroDiskReceipt(receipt({ id: "b", atMs: 20 }));
    writeZeroDiskReceipt(receipt({ id: "a", atMs: 10 }));
    const dir = join(zeroDiskNodeDir(), "receipts");
    writeFileSync(join(dir, "torn.json"), "{\"v\":1,");
    writeFileSync(join(dir, "foreign.json"), json({ hello: "world" }));
    expect(buildZeroDiskReport().receipts.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("a running status whose process is gone is reported as stopped, a live one stays running", () => {
    writeZeroDiskStatus({ platform: "douyin", roomSlug: "1", state: "running", parts: 2 });
    expect(buildZeroDiskReport({ isAlive: () => true }).status[0]).toMatchObject({ state: "running", parts: 2 });
    expect(buildZeroDiskReport({ isAlive: () => false }).status[0]).toMatchObject({ state: "stopped", parts: 2 });
  });
  it("a refused / finished status is reported as written (no liveness downgrade)", () => {
    writeZeroDiskStatus({ platform: "douyin", roomSlug: "1", state: "refused", code: "account_mismatch", message: "m", parts: 0 });
    expect(buildZeroDiskReport({ isAlive: () => false }).status[0]).toMatchObject({ state: "refused", code: "account_mismatch" });
  });
  it("receipts older than the TTL are pruned on the next write; fresh ones survive", () => {
    writeZeroDiskReceipt(receipt({ id: "old" }));
    const dir = join(zeroDiskNodeDir(), "receipts");
    const old = (Date.now() - ZERO_DISK_RECEIPT_TTL_MS - 3600_000) / 1000;
    utimesSync(join(dir, "old.json"), old, old);
    writeZeroDiskReceipt(receipt({ id: "new", atMs: 2000 }));
    expect(readdirSync(dir).sort()).toEqual(["new.json"]);
  });
  it("a receipt write failure surfaces (the caller must say the master cannot learn the BV)", () => {
    mkdirSync(zeroDiskNodeDir(), { recursive: true });
    // a FILE where the receipts directory should be
    writeFileSync(join(zeroDiskNodeDir(), "receipts"), "x");
    expect(() => writeZeroDiskReceipt(receipt())).toThrow();
  });
});

describe("planZeroDiskSpec — the single decision point for what a node is sent", () => {
  const delivery = { ok: true as const, delivery: { v: 1 as const, meta: { tid: 21, tag: "x", private: true }, accountKey: "bilibili:1" } };
  const base = { streamUpload: true, workerId: "vps1", assigned: true, enabled: true, allowsPush: true, build: () => delivery };
  it("supported node: enabled + delivery", () => {
    expect(planZeroDiskSpec(base)).toEqual({ enabled: true, delivery: delivery.delivery });
  });
  it("old / unconfirmed node: sent DISABLED, no delivery (never started with defaults)", () => {
    expect(planZeroDiskSpec({ ...base, allowsPush: false })).toEqual({ enabled: false });
  });
  it("delivery cannot be built (master account unknown): DISABLED with a reason", () => {
    const r = planZeroDiskSpec({ ...base, build: () => ({ ok: false, error: "no account" }) });
    expect(r).toEqual({ enabled: false, blocked: "no account" });
  });
  it("a rebuild failure keeps the last good delivery (a transient login-file read must not stop a live upload)", () => {
    const r = planZeroDiskSpec({ ...base, build: () => ({ ok: false, error: "no account" }), lastGood: delivery.delivery });
    expect(r).toEqual({ enabled: true, delivery: delivery.delivery, stale: "no account" });
    // ... but still honours the source's own enabled flag
    expect(planZeroDiskSpec({ ...base, enabled: false, build: () => ({ ok: false, error: "x" }), lastGood: delivery.delivery }).enabled).toBe(false);
    // a node that does not advertise support never gets a stale delivery either
    expect(planZeroDiskSpec({ ...base, allowsPush: false, lastGood: delivery.delivery })).toEqual({ enabled: false });
  });
  it("local, non-zero-disk and unassigned specs are untouched", () => {
    let built = 0;
    const build = () => { built++; return delivery; };
    expect(planZeroDiskSpec({ ...base, workerId: "local", build })).toEqual({ enabled: true });
    expect(planZeroDiskSpec({ ...base, streamUpload: false, build })).toEqual({ enabled: true });
    expect(planZeroDiskSpec({ ...base, assigned: false, enabled: false, build })).toEqual({ enabled: false });
    expect(built).toBe(0);
  });
  it("an enabled=false source stays disabled even for a supported node", () => {
    expect(planZeroDiskSpec({ ...base, enabled: false })).toMatchObject({ enabled: false });
  });
});

describe("buildZeroDiskDelivery (master side)", () => {
  it("ships the master-resolved metadata (rule > defaults), the master account key and the node credential path", () => {
    const root = useRoot("master");
    writeCookies(root, "42");
    mkdirSync(join(root, "config", "hub"), { recursive: true });
    writeFileSync(join(root, "config", "hub", "douyin.123.json"), json({
      pipeline: { upload: { mode: "rolling", tag: "规则标签", tid: 171, desc: "规则简介", private: false, partTitleTemplate: "{name}-P{part}" } },
    }));
    const r = buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123", workerDataRoot: "/srv/drec" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.delivery).toMatchObject({
        v: 1,
        accountKey: "bilibili:42",
        credentialPath: "/srv/drec/config/biliup/cookies.json",
        meta: { tid: 171, tag: "规则标签", desc: "规则简介", private: false, partTitleTemplate: "{name}-P{part}" },
      });
    }
  });
  it("a rule without private keeps the conservative private=true, explicitly in the delivery", () => {
    const root = useRoot("master");
    writeCookies(root, "42");
    const r = buildZeroDiskDelivery({ platform: "douyin", roomSlug: "999" });
    expect(r.ok && r.delivery.meta.private).toBe(true);
  });
  it("refuses to build when the master's own upload account is not identifiable", () => {
    const root = useRoot("master");
    writeCookies(root, null);
    expect(buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123" })).toMatchObject({ ok: false });
    rmSync(join(root, "config", "biliup", "cookies.json"));
    expect(buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123" })).toMatchObject({ ok: false });
  });
});

describe("end to end: the archive built on a node equals what the master rule says", () => {
  const START = Date.UTC(2026, 8, 12, 17, 30, 0);
  const spec = (over: Partial<RemoteTaskSpec>): RemoteTaskSpec => ({
    platform: "douyin", roomSlug: "123", room: "https://live.douyin.com/123", name: "主播", quality: "origin",
    engine: "ffmpeg", danmu: 1, segmentSec: 1800, scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
    cookies: null, outDir: null, webhook: null, anchorName: null, rollingUpload: false, rollingEffective: false,
    streamUpload: true, streamUploadSpool: false, ...over,
  });

  function masterRule(): void {
    const root = useRoot("master");
    writeCookies(root, "42");
    mkdirSync(join(root, "config", "hub"), { recursive: true });
    writeFileSync(join(root, "config", "hub.config.json"), json({ uploadDefaults: { tag: "默认标签", tid: 17 } }));
    writeFileSync(join(root, "config", "hub", "douyin.123.json"), json({
      pipeline: { upload: {
        mode: "rolling", tag: "规则标签", tid: 171, desc: "规则简介", private: false,
        submissionTitleTemplate: "[{name}]{title}", partTitleTemplate: "{name}-P{part}",
      } },
    }));
  }
  const common = { platform: "douyin", roomSlug: "123", anchorName: "主播", startMs: START, timeZone: "Asia/Shanghai", liveTitle: "今晚直播" };

  it("title / partition / tags / description / visibility / part name are identical on the node (empty rule dir)", () => {
    masterRule();
    const masterMeta = resolveStreamUploadMeta("douyin", "123");
    const masterTitle = resolveStreamUploadTitle(common);
    const masterPart = resolveStreamPartTitle({ ...common, partIndex: 2 });
    expect(masterTitle).toBe("[主播]今晚直播");
    expect(masterPart).toBe("主播-P2");

    // master → spec → node task row
    const built = buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123", workerDataRoot: "/srv/drec" });
    expect(built.ok).toBe(true);
    const dir = mkdtempSync(join(base, "store-"));
    const nodeStore = new TaskStore(join(dir, "tasks.db"));
    applyRemoteTasks(nodeStore, [spec(built.ok ? { zeroDiskDelivery: built.delivery } : {})]);
    const nodeTask = nodeStore.listTasks()[0]!;
    expect(nodeTask.managedBy).toBe("hub");

    // the node: a different data root with NO rule files and the same upload account
    const nodeRoot = useRoot("node");
    writeCookies(nodeRoot, "42");
    const pre = zeroDiskNodePreflight(nodeTask.zeroDiskDelivery);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    const nodeTitle = resolveStreamUploadTitle({ ...common, meta: pre.delivery.meta });
    const nodePart = resolveStreamPartTitle({ ...common, partIndex: 2, meta: pre.delivery.meta });
    expect(nodeTitle).toBe(masterTitle);
    expect(nodePart).toBe(masterPart);
    expect({ tid: pre.delivery.meta.tid, tag: pre.delivery.meta.tag, desc: pre.delivery.meta.desc, private: pre.delivery.meta.private })
      .toEqual({ tid: masterMeta.tid, tag: masterMeta.tag, desc: masterMeta.desc, private: masterMeta.private });
    expect(pre.delivery.meta.private).toBe(false);

    // control: reading the node's own (empty) rule directory is exactly the silent-default bug
    const silent = resolveRollingUploadMeta("douyin", "123");
    expect(silent.private).toBe(true);
    expect(silent.meta.tid).not.toBe(masterMeta.tid);
    expect(resolveStreamUploadTitle(common)).not.toBe(masterTitle);
    nodeStore.close();
  });

  it("without the delivery the node task refuses to start (no silent fallback)", () => {
    masterRule();
    const dir = mkdtempSync(join(base, "store-"));
    const nodeStore = new TaskStore(join(dir, "tasks.db"));
    applyRemoteTasks(nodeStore, [spec({})]); // delivery stripped
    const nodeTask = nodeStore.listTasks()[0]!;
    expect(nodeTask.zeroDiskDelivery).toBeNull();
    const nodeRoot = useRoot("node");
    writeCookies(nodeRoot, "42");
    expect(zeroDiskNodePreflight(nodeTask.zeroDiskDelivery)).toMatchObject({ ok: false, refusal: { code: "delivery_missing" } });
    nodeStore.close();
  });

  it("a changed master rule reaches the node on the next sync (private flips, not stuck on the first value)", () => {
    masterRule();
    const dir = mkdtempSync(join(base, "store-"));
    const nodeStore = new TaskStore(join(dir, "tasks.db"));
    const first = buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123" });
    applyRemoteTasks(nodeStore, [spec(first.ok ? { zeroDiskDelivery: first.delivery } : {})]);
    expect(JSON.parse(nodeStore.listTasks()[0]!.zeroDiskDelivery!).meta.private).toBe(false);
    writeFileSync(join(process.env.DOUYIN_REC_ROOT!, "config", "hub", "douyin.123.json"), json({
      pipeline: { upload: { mode: "rolling", tag: "t", tid: 21, private: true } },
    }));
    const second = buildZeroDiskDelivery({ platform: "douyin", roomSlug: "123" });
    applyRemoteTasks(nodeStore, [spec(second.ok ? { zeroDiskDelivery: second.delivery } : {})]);
    expect(JSON.parse(nodeStore.listTasks()[0]!.zeroDiskDelivery!).meta.private).toBe(true);
    nodeStore.close();
  });

  it("master-local zero-disk is unchanged: no delivery stored, rule directory still read", () => {
    masterRule();
    const dir = mkdtempSync(join(base, "store-"));
    const store = new TaskStore(join(dir, "tasks.db"));
    applyRemoteTasks(store, [spec({})], undefined, { adopt: false });
    const t = store.listTasks()[0]!;
    expect(t.managedBy).toBeNull();
    expect(t.zeroDiskDelivery).toBeNull();
    expect(resolveStreamUploadMeta("douyin", "123").private).toBe(false); // local path still reads the rule
    store.close();
  });
});

describe("makeNodeSubmitGate — zero-disk shares the account window but never blocks live video", () => {
  it("counts every submit in the shared per-account window and cools the account on a rate limit", () => {
    const root = useRoot("node");
    const cookies = writeCookies(root, "42");
    const claims: Array<{ key: string; limit: number }> = [];
    const saved = new Map<string, { blockedUntil: number; times: number[] }>();
    const store = {
      load: (k: string) => saved.get(k) ?? { blockedUntil: 0, times: [] },
      save: (k: string, s: { blockedUntil: number; times: number[] }) => { saved.set(k, s); },
      tryClaim: (key: string, _now: number, _win: number, limit: number) => { claims.push({ key, limit }); return true; },
      close: () => {},
    };
    const logs: string[] = [];
    const gate = makeNodeSubmitGate({ cookiesPath: cookies, store, log: (m) => logs.push(m), now: () => 1_000 });
    gate.noteSubmit();
    expect(claims).toEqual([{ key: "bilibili:42", limit: 5 }]);
    gate.noteRateLimited();
    expect(saved.get("bilibili:42")!.blockedUntil).toBeGreaterThan(Date.now());
  });
  it("a refused claim (window full) is logged and does not throw or block", () => {
    const root = useRoot("node");
    const cookies = writeCookies(root, "42");
    const store = { load: () => ({ blockedUntil: 0, times: [] }), save: () => {}, tryClaim: () => false, close: () => {} };
    const logs: string[] = [];
    const gate = makeNodeSubmitGate({ cookiesPath: cookies, store, log: (m) => logs.push(m) });
    expect(() => gate.noteSubmit()).not.toThrow();
    expect(logs.join("\n")).toContain("submitting anyway");
  });
});

describe("createZeroDiskReporter — one managed run: status trail + exactly one receipt", () => {
  const T0 = Date.UTC(2026, 9, 20, 23, 59, 0); // 2026-10-20 23:59 UTC
  beforeEach(() => { useRoot("node"); });
  const mk = (now = T0) => createZeroDiskReporter({ platform: "douyin", roomSlug: "77", startMs: 1234, now: () => now });

  it("tracks part progress, then writes one receipt keyed like the master-local path", () => {
    const r = mk();
    r.running();
    expect(buildZeroDiskReport({ isAlive: () => true }).status[0]).toMatchObject({ state: "running", parts: 0 });
    r.partConfirmed({ count: 2, bvid: "BVfake1" });
    expect(buildZeroDiskReport({ isAlive: () => true }).status[0]).toMatchObject({ state: "running", parts: 2, bvid: "BVfake1" });
    const fin = r.finish({ ok: true, bvid: "BVfake1", segments: 1 });
    expect(fin).toEqual({ receiptWritten: true });
    const rep = buildZeroDiskReport({ isAlive: () => false });
    expect(rep.receipts).toEqual([{
      v: 1, id: "douyin:77:1234", platform: "douyin", roomSlug: "77", streamKey: "douyin:77:2026-10-20", bvid: "BVfake1", parts: 2, atMs: T0,
    }]);
    expect(rep.status[0]).toMatchObject({ state: "finished", parts: 2, bvid: "BVfake1" });
  });
  it("parts = the larger of confirmed-so-far and this run's segments", () => {
    const r = mk();
    r.finish({ ok: true, bvid: "BVfake1", segments: 3 });
    expect(buildZeroDiskReport().receipts[0]!.parts).toBe(3);
  });
  it("a run that delivered nothing, or failed, leaves no receipt", () => {
    const idle = mk();
    expect(idle.finish({ ok: true, segments: 0 })).toEqual({ receiptWritten: false });
    expect(buildZeroDiskReport().receipts).toHaveLength(0);
    expect(buildZeroDiskReport({ isAlive: () => false }).status[0]).toMatchObject({ state: "finished" });
    const bad = mk();
    bad.finish({ ok: false, error: "upload failed", segments: 1 });
    expect(buildZeroDiskReport().receipts).toHaveLength(0);
    expect(buildZeroDiskReport({ isAlive: () => false }).status[0]).toMatchObject({ state: "failed", message: "upload failed" });
  });
  it("a receipt that cannot be written is reported loudly (status failed + receiptError)", () => {
    mkdirSync(zeroDiskNodeDir(), { recursive: true });
    writeFileSync(join(zeroDiskNodeDir(), "receipts"), "x"); // blocks the receipts directory
    const fin = mk().finish({ ok: true, bvid: "BVfake1", segments: 1 });
    expect(fin.receiptWritten).toBe(false);
    expect(fin.receiptError).toContain("master ledger will not record it");
    expect(buildZeroDiskReport({ isAlive: () => false }).status[0]).toMatchObject({ state: "failed" });
  });
  it("the same run finishing twice (a restart inside one process id) cannot create a second receipt", () => {
    const a = mk();
    expect(a.finish({ ok: true, bvid: "BVfake1", segments: 1 }).receiptWritten).toBe(true);
    const b = mk(); // same startMs => same id
    expect(b.finish({ ok: true, bvid: "BVother", segments: 1 }).receiptWritten).toBe(false);
    expect(buildZeroDiskReport().receipts.map((r) => r.bvid)).toEqual(["BVfake1"]);
  });
});
