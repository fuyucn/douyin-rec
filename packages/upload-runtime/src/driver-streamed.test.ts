/**
 * driver.ts streamed publish (plans/049 stage 2b-2b): the same decisions as create/append, applied
 * to a part whose bytes the transport already received.
 */
import { describe, it, expect } from "vitest";
import type {
  ArchiveInfo,
  PublishStreamedInput,
  PublishStreamedResult,
  UploadErrorClass,
  UploadPolicy,
  UploadTarget,
} from "@drec/core";
import type { UploadCheckpoint, UploadPartRecord, UploadStateStore } from "./state-store.js";
import { createUploadDriver, UploadDriverError } from "./driver.js";

const POLICY: UploadPolicy = { visibility: "private", watermark: false, copyright: "self" };
const CRED = { targetId: "t", locator: "ck" };
const REF = { targetId: "t", id: "a1" };
const ARCHIVE = { title: "T", tid: 1, tags: [], policy: POLICY };

class RateLimited extends Error {}
class Transient extends Error {}

function memoryStore(): UploadStateStore & { saved: UploadCheckpoint[]; parts: UploadPartRecord[] } {
  const saved: UploadCheckpoint[] = [];
  const parts: UploadPartRecord[] = [];
  const byKey = new Map<string, UploadCheckpoint>();
  return {
    saved,
    parts,
    load: (key) => byKey.get(key) ?? null,
    save: (key, cp) => { saved.push(cp); byKey.set(key, cp); },
    confirmPart: (key, part) => {
      parts.push(part);
      const cur = byKey.get(key);
      if (cur) byKey.set(key, { ...cur, parts: [...cur.parts, part] });
    },
  };
}

function driver(o: {
  publishStreamed?: (input: PublishStreamedInput) => Promise<PublishStreamedResult>;
  findRecent?: UploadTarget["findRecent"];
  streamPublish?: boolean;
  retryAttempts?: number;
  accounting?: { noteSubmit(): void; noteRateLimited(): void };
} = {}) {
  const store = memoryStore();
  const sleeps: number[] = [];
  const calls: PublishStreamedInput[] = [];
  const findRecentCalls: Array<Parameters<UploadTarget["findRecent"]>[0]> = [];
  const target: UploadTarget = {
    id: "t",
    platformIds: ["p"],
    resolveCredential: () => CRED,
    accountKey: () => "t:0",
    hardPolicy: () => POLICY,
    defaults: () => ({ tid: 1, tags: [], titleMaxLength: 80, maxParts: null }),
    create: async () => ({ proof: "created", ref: REF }),
    append: async () => ({ proof: "observed" }),
    inspect: async () => ({ ref: REF, title: "T", partCount: 1 } as ArchiveInfo),
    findRecent: async (input) => { findRecentCalls.push(input); return o.findRecent ? o.findRecent(input) : "none"; },
    classifyError: (err): UploadErrorClass =>
      err instanceof RateLimited
        ? { kind: "rate-limited", retryAfterMs: 7 }
        : err instanceof Transient
          ? { kind: "transient", reason: "t" }
          : { kind: "permanent", reason: String((err as Error)?.message ?? err) },
    capabilities: { appendGranularity: "single", seasons: false, ...(o.streamPublish === false ? {} : { streamPublish: true }) },
    ...(o.publishStreamed
      ? { publishStreamed: async (input: PublishStreamedInput) => { calls.push(input); return o.publishStreamed!(input); } }
      : {}),
  };
  const d = createUploadDriver({
    target,
    store,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 1_700_000_000_000,
    log: () => {},
    retry: { attempts: o.retryAttempts ?? 3, transientBaseMs: 1_000, rateLimitMs: 60_000, maxWaitMs: 300_000 },
    ...(o.accounting ? { accounting: o.accounting } : {}),
  });
  return { d, store, sleeps, calls, findRecentCalls };
}

/** Records what the driver told the shared account window, in order. */
function accountingSpy(limitFailures = 0) {
  const events: Array<"submit" | "rate-limited"> = [];
  let failures = 0;
  return {
    events,
    account: {
      noteSubmit() { events.push("submit"); },
      noteRateLimited() { failures++; events.push("rate-limited"); },
    },
    get rateLimitedCalls() { return failures; },
    /** true while the fake target should keep answering with a rate limit */
    shouldFail(n: number) { return n <= limitFailures; },
  };
}

describe("upload driver: streamed publish", () => {
  it("creates with metadata only and stores a checkpoint", async () => {
    const { d, store, calls } = driver({ publishStreamed: async () => ({ proof: "created", ref: REF }) });
    const out = await d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0", title: "P1", expectedDurationSec: 10 });
    expect(out).toEqual({ ref: REF, reused: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ref).toBeNull();
    expect(calls[0]!.archive).toMatchObject({ title: "T" });
    expect(store.saved).toEqual([{ targetId: "t", archiveId: "a1", parts: [] }]);
  });

  it("reuses a matching archive without publishing anything", async () => {
    const { d, calls } = driver({
      findRecent: async () => ({ ref: REF, title: "T", partCount: 2 }),
      publishStreamed: async () => ({ proof: "created", ref: REF }),
    });
    const out = await d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0" });
    expect(out).toEqual({ ref: REF, reused: true });
    expect(calls).toHaveLength(0);
  });

  it("an unreadable archive list never creates a second archive", async () => {
    const { d, calls } = driver({
      findRecent: async () => "unknown",
      publishStreamed: async () => ({ proof: "created", ref: REF }),
    });
    await expect(d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0" }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls).toHaveLength(0);
  });

  it("a create with no readable id is needs-manual and is not retried", async () => {
    const { d, calls } = driver({ publishStreamed: async () => ({ proof: "unknown", ref: null }) });
    await expect(d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0" }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls).toHaveLength(1);
  });

  it("appends one part and continues the checkpoint numbering", async () => {
    const { d, store, calls } = driver({ publishStreamed: async () => ({ proof: "confirmed", ref: REF }) });
    store.save("t:a1", { targetId: "t", archiveId: "a1", parts: [{ index: 1, size: 6, mtimeMs: 0 }] });
    const out = await d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem1", title: "P2", size: 6 });
    expect(out).toEqual({ confirmed: [2] });
    expect(calls[0]!.ref).toEqual(REF);
    expect(store.parts.map((p) => p.index)).toEqual([2]);
  });

  it("retries only confirmed-not-submitted, then records the part", async () => {
    let n = 0;
    const { d, store, sleeps } = driver({
      publishStreamed: async () => {
        n++;
        return n < 2 ? { proof: "confirmed-not-submitted", ref: null } : { proof: "confirmed", ref: REF };
      },
    });
    const out = await d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 });
    expect(out).toEqual({ confirmed: [1] });
    expect(sleeps).toEqual([1_000]);
    expect(store.parts).toHaveLength(1);
  });

  it("an unreadable append records nothing and stops", async () => {
    const { d, store, calls } = driver({ publishStreamed: async () => ({ proof: "unknown", ref: null }) });
    await expect(d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls).toHaveLength(1);
    expect(store.parts).toHaveLength(0);
  });

  it("a rate-limited publish waits the hint and then succeeds", async () => {
    let n = 0;
    const { d, sleeps } = driver({
      publishStreamed: async () => {
        n++;
        if (n < 2) throw new RateLimited("code:21540");
        return { proof: "confirmed", ref: REF };
      },
    });
    await d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 });
    expect(sleeps).toEqual([7]);
  });

  it("a target without the capability is refused instead of uploading twice", async () => {
    const { d, calls } = driver({ streamPublish: false, findRecent: async () => "none" });
    await expect(d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0" }))
      .rejects.toMatchObject({ failure: "fatal" });
    expect(calls).toHaveLength(0);
  });

  it("counts every publish attempt in the shared account window", async () => {
    const spy = accountingSpy();
    let n = 0;
    const { d } = driver({
      accounting: spy.account,
      publishStreamed: async () => {
        n++;
        if (n < 2) throw new RateLimited("code:21540");
        return { proof: "confirmed", ref: REF };
      },
    });
    await d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 });
    // An attempt is recorded before each request, and a rate limit cools the account.
    expect(spy.events).toEqual(["submit", "rate-limited", "submit"]);
  });

  it("cools the account when the rate limit outlives the attempt budget", async () => {
    const spy = accountingSpy();
    const { d } = driver({
      retryAttempts: 3,
      accounting: spy.account,
      publishStreamed: async () => { throw new RateLimited("code:21540"); },
    });
    await expect(d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 }))
      .rejects.toMatchObject({ failure: "retry-exhausted" });
    // Three attempts, three rate-limit discounts: the account is cooling either way, and the
    // next upload on this node must see it.
    expect(spy.events.filter((e) => e === "submit")).toHaveLength(3);
    expect(spy.rateLimitedCalls).toBe(3);
  });

  it("accounting failures never stop a publish", async () => {
    let n = 0;
    const { d, store } = driver({
      accounting: {
        noteSubmit() { throw new Error("store closed"); },
        noteRateLimited() { throw new Error("store closed"); },
      },
      publishStreamed: async () => {
        n++;
        if (n < 2) throw new RateLimited("code:21540");
        return { proof: "confirmed", ref: REF };
      },
    });
    // A broken accounting store must not be able to eat a live part: the retry still happens and
    // the confirmation is still recorded.
    const out = await d.appendStreamedPart({ cred: CRED, ref: REF, name: "stem0", size: 6 });
    expect(out).toEqual({ confirmed: [1] });
    expect(store.parts).toHaveLength(1);
  });

  it("a fresh create skips the title dedupe when asked, and still searches otherwise", async () => {
    const skipped = driver({ publishStreamed: async () => ({ proof: "created", ref: REF }) });
    await skipped.d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0", skipFindRecent: true });
    expect(skipped.findRecentCalls).toHaveLength(0);

    const searched = driver({ publishStreamed: async () => ({ proof: "created", ref: REF }) });
    await searched.d.ensureStreamedArchive({ cred: CRED, archive: ARCHIVE, name: "stem0" });
    expect(searched.findRecentCalls).toHaveLength(1);
    expect(searched.findRecentCalls[0]!.title).toBe("T");
  });
});
