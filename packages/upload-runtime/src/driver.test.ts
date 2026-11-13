import { describe, it, expect } from "vitest";
import type {
  AppendPartsResult,
  ArchiveInfo,
  CreateArchiveResult,
  UploadErrorClass,
  UploadTarget,
} from "@drec/core";
import type { UploadCheckpoint, UploadPartRecord, UploadStateStore } from "./state-store.js";
import { createUploadDriver, UploadDriverError } from "./driver.js";

const POLICY = { visibility: "private" as const, watermark: false as const, copyright: "self" as const };
const CRED = { targetId: "t", locator: "ck" };
const REF = { targetId: "t", id: "a1" };

function memoryStore(): UploadStateStore & { saved: UploadCheckpoint[]; parts: UploadPartRecord[] } {
  const saved: UploadCheckpoint[] = [];
  const parts: UploadPartRecord[] = [];
  const byKey = new Map<string, UploadCheckpoint>();
  return {
    saved,
    parts,
    load: (key) => byKey.get(key) ?? null,
    save: (key, checkpoint) => {
      saved.push(checkpoint);
      byKey.set(key, checkpoint);
    },
    confirmPart: (key, part) => {
      parts.push(part);
      const cur = byKey.get(key);
      if (cur) byKey.set(key, { ...cur, parts: [...cur.parts, part] });
    },
  };
}

function fakeTarget(o: {
  findRecent?: UploadTarget["findRecent"];
  create?: UploadTarget["create"];
  append?: UploadTarget["append"];
  inspect?: UploadTarget["inspect"];
  classify?: (err: unknown) => UploadErrorClass;
}) {
  const calls = { create: 0, append: 0, findRecent: 0 };
  const target: UploadTarget = {
    id: "t",
    platformIds: ["p"],
    resolveCredential: () => CRED,
    accountKey: () => "t:0",
    hardPolicy: () => POLICY,
    defaults: () => ({ tid: 1, tags: [], titleMaxLength: 80, maxParts: null }),
    create: async (input) => {
      calls.create++;
      if (o.create) return o.create(input);
      return { proof: "created", ref: REF } as CreateArchiveResult;
    },
    append: async (input) => {
      calls.append++;
      if (o.append) return o.append(input);
      return { proof: "observed" } as AppendPartsResult;
    },
    inspect: async (input) => {
      if (o.inspect) return o.inspect(input);
      return { ref: REF, title: "x", partCount: 1 } as ArchiveInfo;
    },
    findRecent: async (input) => {
      calls.findRecent++;
      if (o.findRecent) return o.findRecent(input);
      return "none";
    },
    classifyError: (err) =>
      o.classify
        ? o.classify(err)
        : err instanceof RateLimited
          ? { kind: "rate-limited", retryAfterMs: 7 }
          : err instanceof Transient
            ? { kind: "transient", reason: "t" }
            : { kind: "permanent", reason: String((err as Error)?.message ?? err) },
    capabilities: { appendGranularity: "single", seasons: false },
  };
  return { target, calls };
}

class RateLimited extends Error {}
class Transient extends Error {}

function driver(o: Parameters<typeof fakeTarget>[0], extra: { attempts?: number } = {}) {
  const store = memoryStore();
  const sleeps: number[] = [];
  const { target, calls } = fakeTarget(o);
  const d = createUploadDriver({
    target,
    store,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_700_000_000_000,
    log: () => {},
    retry: { attempts: extra.attempts ?? 3, transientBaseMs: 1_000, rateLimitMs: 60_000, maxWaitMs: 300_000 },
  });
  return { d, store, sleeps, calls };
}

const FILES = [{ path: "/tmp/a.mp4", title: "P1", size: 6, mtimeMs: 7 }];

describe("upload driver: ensureArchive", () => {
  it("creates when findRecent is empty, then stores a checkpoint", async () => {
    const { d, store, calls } = driver({});
    const out = await d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY });
    expect(out.reused).toBe(false);
    expect(out.ref).toEqual(REF);
    expect(calls.create).toBe(1);
    expect(store.saved).toEqual([{ targetId: "t", archiveId: "a1", parts: [] }]);
  });

  it("reuses an existing archive without creating", async () => {
    const { d, calls } = driver({
      findRecent: async () => ({ ref: REF, title: "标题", partCount: 2 }),
    });
    const out = await d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY });
    expect(out).toEqual({ ref: REF, reused: true });
    expect(calls.create).toBe(0);
  });

  it("an unreadable dedupe lookup is needs-manual, not a new archive", async () => {
    const { d, calls } = driver({ findRecent: async () => "unknown" });
    await expect(d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls.create).toBe(0);
  });

  it("create proof unknown is needs-manual and is not retried", async () => {
    const { d, calls } = driver({ create: async () => ({ proof: "unknown", ref: null }) });
    await expect(d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls.create).toBe(1);
  });

  it("create proof unknown with a readable ref is still needs-manual", async () => {
    // A ref alone does not prove the archive exists; publishing again would build a second one.
    const { d, calls, store } = driver({ create: async () => ({ proof: "unknown", ref: REF }) });
    await expect(d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(calls.create).toBe(1);
    expect(store.saved).toHaveLength(0);
  });

  it("retries transient failures with a growing backoff", async () => {
    let n = 0;
    const { d, sleeps, calls } = driver({
      create: async () => {
        n++;
        if (n < 3) throw new Transient("socket");
        return { proof: "created", ref: REF };
      },
    });
    const out = await d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY });
    expect(out.reused).toBe(false);
    expect(calls.create).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it("honours the rate-limit hint instead of the backoff", async () => {
    let n = 0;
    const { d, sleeps } = driver({
      create: async () => {
        n++;
        if (n < 2) throw new RateLimited("code:21540");
        return { proof: "created", ref: REF };
      },
    });
    await d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY });
    expect(sleeps).toEqual([7]);
  });

  it("a permanent failure stops immediately", async () => {
    const { d, sleeps, calls } = driver({
      create: async () => {
        throw new Error("21001 参数错误");
      },
    });
    await expect(d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "fatal" });
    expect(calls.create).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("gives up after the attempt budget", async () => {
    const { d, calls } = driver(
      { create: async () => { throw new Transient("socket"); } },
      { attempts: 2 },
    );
    await expect(d.ensureArchive({ cred: CRED, title: "标题", files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "retry-exhausted" });
    expect(calls.create).toBe(2);
  });
});

describe("upload driver: appendParts", () => {
  it("confirms the files with continuing part numbers", async () => {
    const { d, store } = driver({});
    const first = await d.appendParts({ cred: CRED, ref: REF, files: FILES, policy: POLICY });
    expect(first.confirmed).toEqual([1]);
    const second = await d.appendParts({
      cred: CRED,
      ref: REF,
      files: [{ path: "/tmp/b.mp4", size: 4, mtimeMs: 8 }],
      policy: POLICY,
    });
    expect(second.confirmed).toEqual([2]);
    expect(store.parts.map((p) => [p.index, p.size])).toEqual([[1, 6], [2, 4]]);
  });

  it("proof unknown is needs-manual and records no part", async () => {
    const { d, store } = driver({ append: async () => ({ proof: "unknown" }) });
    await expect(d.appendParts({ cred: CRED, ref: REF, files: FILES, policy: POLICY }))
      .rejects.toMatchObject({ failure: "needs-manual" });
    expect(store.parts).toEqual([]);
  });

  it("retries only when the target proved nothing was submitted", async () => {
    let n = 0;
    const { d, sleeps } = driver({
      append: async () => {
        n++;
        return n < 2 ? { proof: "confirmed-not-submitted" } : { proof: "observed" };
      },
    });
    const out = await d.appendParts({ cred: CRED, ref: REF, files: FILES, policy: POLICY });
    expect(out.confirmed).toEqual([1]);
    expect(sleeps).toEqual([1_000]);
  });

  it("an ambiguous error is needs-manual on the first attempt", async () => {
    const { d, calls } = driver({
      append: async () => { throw new Error("ambiguous"); },
      classify: () => ({ kind: "ambiguous", reason: "request may have landed" }),
    });
    await expect(d.appendParts({ cred: CRED, ref: REF, files: FILES, policy: POLICY }))
      .rejects.toBeInstanceOf(UploadDriverError);
    expect(calls.append).toBe(1);
  });
});

describe("upload driver: verify", () => {
  it("compares the observed count with the expected one", async () => {
    const { d } = driver({ inspect: async () => ({ ref: REF, title: "x", partCount: 3 }) });
    expect(await d.verify({ cred: CRED, ref: REF, expectedParts: 3 })).toEqual({ ok: true, observedParts: 3 });
    expect(await d.verify({ cred: CRED, ref: REF, expectedParts: 4 })).toEqual({ ok: false, observedParts: 3 });
  });

  it("an unreadable archive is not a pass", async () => {
    const { d } = driver({ inspect: async () => null });
    expect(await d.verify({ cred: CRED, ref: REF, expectedParts: null }))
      .toEqual({ ok: false, observedParts: null });
  });
});

