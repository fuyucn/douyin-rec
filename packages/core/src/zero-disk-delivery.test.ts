import { describe, expect, it } from "vitest";
import {
  isKnownAccountKey,
  normalizeZeroDiskReceipt,
  zeroDiskReceiptLedgerEntry,
  zeroDiskStreamKey,
  normalizeZeroDiskReport,
  normalizeZeroDiskStatus,
  parseZeroDiskDelivery,
  zeroDiskAccountVerdict,
} from "./zero-disk-delivery.js";

const GOOD = {
  v: 1,
  meta: { tid: 171, tag: "a,b", private: false, desc: "d", titleTemplate: "T", submissionTitleTemplate: "S", partTitleTemplate: "P" },
  accountKey: "bilibili:42",
  credentialPath: "/data/config/biliup/cookies.json",
};

describe("parseZeroDiskDelivery — strict, no defaults", () => {
  it("accepts a complete object and keeps every field", () => {
    const r = parseZeroDiskDelivery(GOOD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.meta).toEqual({ tid: 171, tag: "a,b", private: false, desc: "d", titleTemplate: "T", submissionTitleTemplate: "S", partTitleTemplate: "P" });
      expect(r.value.accountKey).toBe("bilibili:42");
      expect(r.value.credentialPath).toBe("/data/config/biliup/cookies.json");
    }
  });
  it("private must be an explicit boolean (visibility is never defaulted)", () => {
    for (const bad of [undefined, null, "false", 0, 1]) {
      const r = parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, private: bad } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("private");
    }
  });
  it("rejects a missing / mistyped tid, tag, meta, version and unknown account", () => {
    expect(parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, tid: 0 } }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, tid: "171" } }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, tag: " " } }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, meta: undefined }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, v: 2 }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, accountKey: "bilibili:unknown" }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, accountKey: undefined }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, desc: 5 } }).ok).toBe(false);
    expect(parseZeroDiskDelivery({ ...GOOD, credentialPath: 5 }).ok).toBe(false);
    expect(parseZeroDiskDelivery(null).ok).toBe(false);
    expect(parseZeroDiskDelivery([]).ok).toBe(false);
  });
  it("optional text fields may be absent", () => {
    const r = parseZeroDiskDelivery({ v: 1, meta: { tid: 21, tag: "x", private: true }, accountKey: "bilibili:1" });
    expect(r.ok).toBe(true);
  });
  it("seasonSectionId is optional but must be a positive integer", () => {
    const good = parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, seasonSectionId: 123 } });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.meta.seasonSectionId).toBe(123);
    for (const bad of [0, -1, 1.5, "123"]) {
      expect(parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, seasonSectionId: bad } }).ok).toBe(false);
    }
    const absent = parseZeroDiskDelivery({ ...GOOD, meta: { ...GOOD.meta, seasonSectionId: null } });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value.meta.seasonSectionId).toBeUndefined();
  });
});

describe("account verdict", () => {
  it("equal known keys verify", () => {
    expect(zeroDiskAccountVerdict("bilibili:1", "bilibili:1")).toBeNull();
  });
  it("different accounts are a mismatch (and the message carries no key)", () => {
    const v = zeroDiskAccountVerdict("bilibili:1", "bilibili:2");
    expect(v?.code).toBe("account_mismatch");
    expect(v?.message).not.toContain("bilibili:");
  });
  it("an unidentifiable account on either side cannot be verified", () => {
    expect(zeroDiskAccountVerdict("bilibili:1", "bilibili:unknown")?.code).toBe("account_unknown");
    expect(zeroDiskAccountVerdict("bilibili:unknown", "bilibili:1")?.code).toBe("account_unknown");
    expect(isKnownAccountKey("")).toBe(false);
  });
});

describe("receipt / status / report normalizers", () => {
  const receipt = { v: 1, id: "douyin:1:5", platform: "douyin", roomSlug: "1", streamKey: "douyin:1:2026-10-20", bvid: "BVx", parts: 2, atMs: 5 };
  it("keeps well-formed receipts and drops malformed ones", () => {
    expect(normalizeZeroDiskReceipt(receipt)).toEqual(receipt);
    expect(normalizeZeroDiskReceipt({ ...receipt, bvid: "" })).toBeNull();
    expect(normalizeZeroDiskReceipt({ ...receipt, parts: -1 })).toBeNull();
    expect(normalizeZeroDiskReceipt({ ...receipt, v: 2 })).toBeNull();
  });
  it("status: unknown state / refusal code are not trusted", () => {
    const st = { v: 1, platform: "douyin", roomSlug: "1", state: "refused", code: "account_mismatch", parts: 0, updatedAt: 1 };
    expect(normalizeZeroDiskStatus(st)?.code).toBe("account_mismatch");
    expect(normalizeZeroDiskStatus({ ...st, state: "weird" })).toBeNull();
    expect(normalizeZeroDiskStatus({ ...st, code: "weird" })?.code).toBeUndefined();
  });
  it("report drops bad entries instead of failing the whole poll", () => {
    const r = normalizeZeroDiskReport({ v: 1, receipts: [receipt, { nope: 1 }], status: [null] });
    expect(r?.receipts).toHaveLength(1);
    expect(r?.status).toHaveLength(0);
    expect(normalizeZeroDiskReport({ v: 2 })).toBeNull();
    expect(normalizeZeroDiskReport("x")).toBeNull();
  });
});

describe("zero-disk receipt ledger key (issue #324)", () => {
  const base = { v: 1 as const, id: "douyin:1:5", platform: "douyin", roomSlug: "1", bvid: "BV1x", parts: 2, atMs: Date.UTC(2026, 9, 19, 12, 0) };
  it("keeps the node's -zd key and start time as sent", () => {
    const key = zeroDiskStreamKey("douyin", "1", 1_000_000, "UTC");
    expect(zeroDiskReceiptLedgerEntry({ ...base, streamKey: key, startMs: 1_000_000 })).toEqual({ streamKey: key, startMs: 1_000_000 });
  });
  it("re-keys a legacy receipt (no startMs, bare date key) into the -zd namespace", () => {
    const e = zeroDiskReceiptLedgerEntry({ ...base, streamKey: "douyin:1:2026-10-19" }, "UTC");
    expect(e.streamKey).toBe("douyin:1:2026-10-19_1200-zd");
    expect(e.startMs).toBe(base.atMs);
  });
  it("startMs survives the receipt round trip and stays optional", () => {
    const r = { ...base, streamKey: "k", startMs: 42 };
    expect(normalizeZeroDiskReceipt(r)).toEqual({ ...r });
    expect(normalizeZeroDiskReceipt({ ...base, streamKey: "k", startMs: "x" })).toEqual({ ...base, streamKey: "k" });
  });
});
