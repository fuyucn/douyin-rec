/**
 * apply-cookies.test.ts — master → worker platform credential push (issue #563).
 *
 * Two invariants are safety-critical and pinned here:
 *   1. an empty/missing/malformed payload never deletes a worker's login (a logged-out master must not
 *      silently turn every node anonymous);
 *   2. douyin writes the compat key as well, so the expiry watchdog and the recorder read one value.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { applyPlatformCookies, collectPlatformCookies, decodeApplyCookies } from "../../packages/app/src/apply-cookies.js";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
/** `sid_guard=<tok>|<loginTs>|<maxAgeSec>|<GMT>` — the only expiry-carrying platform field. */
const douyin = (loginTs: number, maxAgeSec: number): string =>
  `sessionid=ABC; sid_guard=tok%7C${loginTs}%7C${maxAgeSec}%7CWed`;

describe("decodeApplyCookies", () => {
  // Review F2: folding a bad payload into an empty one makes the node report success, the master record
  // the fingerprint, and the node stay anonymous until the next login. It must throw instead.
  it("garbage / non-JSON / wrong shape → throws (never a silent empty success)", () => {
    expect(() => decodeApplyCookies("!!!")).toThrow(/base64|JSON/);
    expect(() => decodeApplyCookies(encode(null))).toThrow(/对象/);
    expect(() => decodeApplyCookies(encode({ platformCookies: "nope" }))).toThrow(/platformCookies/);
  });

  it("classifies unknown platforms (unsupported) vs unusable values (rejected)", () => {
    const b64 = encode({
      platformCookies: {
        douyin: "  sessionid=A  ",
        "not-a-platform": "x",
        bilibili: 42,
      },
    });
    expect(decodeApplyCookies(b64)).toEqual({
      platformCookies: { douyin: "sessionid=A" },
      // Bundle skew: this node has no such platform → never applicable, must not trigger endless retries.
      unsupported: ["not-a-platform"],
      // Corrupted/truncated value → the master must retry instead of recording a half-apply.
      rejected: ["bilibili"],
    });
  });

  it("empty values are a deliberate no-op (neither applied nor reported)", () => {
    const b64 = encode({ platformCookies: { douyin: "", bilibili: "   " } });
    expect(decodeApplyCookies(b64)).toEqual({ platformCookies: {}, unsupported: [], rejected: [] });
  });
});

describe("applyPlatformCookies", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apply-cookies-"));
    store = new TaskStore(join(dir, "tasks.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a changed value and mirrors douyin into the compat key", () => {
    const value = douyin(1_700_000_000, 3600);
    const r = applyPlatformCookies(store, { platformCookies: { douyin: value }, unsupported: [], rejected: [] });
    expect(r.applied).toEqual(["douyin"]);
    expect(store.getPlatformCookies("douyin")).toBe(value);
    expect(store.getDefaultCookies()).toBe(value);
  });

  it("compat key already equals the value (map empty) → unchanged (effective comparison, no churn)", () => {
    const value = douyin(1_700_000_000, 3600);
    store.setSetting("defaultCookies", value); // legacy node: only the compat key is populated
    const r = applyPlatformCookies(store, { platformCookies: { douyin: value }, unsupported: [], rejected: [] });
    expect(r).toMatchObject({ applied: [], unchanged: ["douyin"] });
  });

  it("same effective value → unchanged, no rewrite", () => {
    const value = douyin(1_700_000_000, 3600);
    applyPlatformCookies(store, { platformCookies: { douyin: value }, unsupported: [], rejected: [] });
    // The compat key already holds it: a douyin node must report unchanged instead of churning both keys
    // on every sync tick.
    const r = applyPlatformCookies(store, { platformCookies: { douyin: value }, unsupported: [], rejected: [] });
    expect(r).toMatchObject({ applied: [], unchanged: ["douyin"] });
  });

  it("empty payload never deletes an existing login", () => {
    const value = douyin(1_700_000_000, 3600);
    applyPlatformCookies(store, { platformCookies: { douyin: value }, unsupported: [], rejected: [] });
    const r = applyPlatformCookies(store, { platformCookies: {}, unsupported: [], rejected: [] });
    expect(r).toEqual({ applied: [], unchanged: [] });
    expect(store.getPlatformCookies("douyin")).toBe(value);
  });

  it("unsupported/rejected are carried into the result so the master can decide record-vs-retry", () => {
    const r = applyPlatformCookies(store, { platformCookies: {}, unsupported: ["foo"], rejected: ["bilibili"] });
    expect(r).toMatchObject({ unsupported: ["foo"], rejected: ["bilibili"] });
  });

  it("only platforms present in the payload are touched (bilibili keeps its own)", () => {
    store.setPlatformCookies("bilibili", "SESSDATA=OLD");
    const r = applyPlatformCookies(store, { platformCookies: { douyin: douyin(1_700_000_000, 3600) }, unsupported: [], rejected: [] });
    expect(r.applied).toEqual(["douyin"]);
    expect(store.getPlatformCookies("bilibili")).toBe("SESSDATA=OLD");
  });
});

describe("collectPlatformCookies", () => {
  it("collects the effective value per platform and omits empty ones", () => {
    const stub = {
      getPlatformCookies: (p: string) =>
        p === "douyin" ? "sessionid=D" : p === "bilibili" ? "  " : null,
    };
    expect(collectPlatformCookies(stub as never)).toEqual({ platformCookies: { douyin: "sessionid=D" } });
  });
});
