/**
 * Streamed-upload tasks use the driver-backed submitter (plans/049 stage 2b-2c).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveInfo, PublishStreamedInput, PublishStreamedResult, UploadErrorClass, UploadTarget } from "@drec/core";
import { livePumpStatePath, writeLivePumpState } from "@drec/zero-upload";
import { abortableSleep, buildLivePumpSubmitter } from "./live-pump-submitter.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const base = {
  cookiesPath: "/tmp/cookies.json",
  spoolDir: "/tmp/spool",
  pumpRoom: "r",
};

function streamedWire() {
  const hits: string[] = [];
  const posts: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    hits.push(path);
    if (path === "/x/vu/web/add/v3" || path === "/x/vu/web/edit") {
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      return Response.json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } });
    }
    if (path === "/x/vupre/web/archive/view") {
      const latest = posts.at(-1) as { videos?: Array<{ filename: string; title: string }> } | undefined;
      return Response.json({ code: 0, data: {
        archive: { aid: 7, bvid: "BILIfake1", title: "T", tid: 21, is_only_self: 1 },
        videos: (latest?.videos ?? [{ filename: "stem0", title: "P1" }]).map((video, index) => ({ cid: index + 1, ...video })),
      } });
    }
    throw new Error("Unexpected network request: " + path);
  };
  return { fetchImpl, hits, posts };
}

describe("buildLivePumpSubmitter", () => {
  it("publishes by default and resumes the next part despite a retired off flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-driver-default-"));
    try {
      const cookiesPath = join(dir, "cookies.json");
      writeFileSync(cookiesPath, JSON.stringify({ cookie_info: { cookies: [
        { name: "SESSDATA", value: "test-session" }, { name: "bili_jct", value: "test-csrf" },
      ] } }));
      const wire = streamedWire();
      vi.stubGlobal("fetch", wire.fetchImpl);
      vi.stubEnv("DREC_LIVE_PUMP_DRIVER", undefined);
      const noteSubmit = vi.fn();
      const opts = { cookiesPath, spoolDir: dir, pumpRoom: "test-room",
        submitGate: { noteSubmit, noteRateLimited: vi.fn() } };
      const created = await buildLivePumpSubmitter(opts).ensureStreamedArchive({
        archive: ARCHIVE, name: "stem0", title: "P1", skipFindRecent: true,
      });
      expect(created).toEqual({ ref: { targetId: "bilibili-upos", id: "BILIfake1" }, reused: false, partProof: "observed" });
      const part = { spoolPath: join(dir, "p1.ts"), filename: "p1.ts", stem: "stem0",
        title: "P1", bytes: 1, durationSec: 180 };
      writeLivePumpState(livePumpStatePath(dir, opts.pumpRoom), {
        schemaVersion: 1, room: opts.pumpRoom, createdAt: 1, updatedAt: 1,
        title: "T", tid: 21, tag: "", private: true, bvid: created.ref.id,
        parts: [{ ...part, index: 0, confirmed: false, proof: "accepted", nativeKey: "stem0", acceptedAt: 1 },
          { ...part, index: 1, confirmed: false }],
      });
      vi.stubEnv("DREC_LIVE_PUMP_DRIVER", "0");
      const resumed = buildLivePumpSubmitter(opts);
      await expect(resumed.appendStreamedPart({ ref: created.ref, name: "stem1", title: "P2", size: 1 }))
        .rejects.toMatchObject({ failure: "needs-manual" });
      expect(resumed.observeStreamedPart({ ref: created.ref, name: "stem0" })).toBeUndefined();
      await expect(resumed.appendStreamedPart({ ref: created.ref, name: "stem1", title: "P2", size: 1 }))
        .resolves.toEqual({ confirmed: [2], accepted: [] });
      expect(wire.hits).toEqual([
        "/x/vu/web/add/v3", "/x/vupre/web/archive/view",
        "/x/vupre/web/archive/view", "/x/vu/web/edit", "/x/vupre/web/archive/view",
      ]);
      expect(wire.posts[0]).toMatchObject({ is_only_self: 1, copyright: 1, watermark: { state: 0 },
        videos: [{ filename: "stem0", title: "P1" }] });
      expect(wire.posts[1]).toMatchObject({ aid: 7, is_only_self: 1, watermark: { state: 0 },
        videos: [{ filename: "stem0", title: "P1" }, { filename: "stem1", title: "P2" }] });
      expect(noteSubmit).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Rate-limited error the fake target classifies as retryable-after-cooldown. */
class FakeRateLimited extends Error {}

/**
 * The driver wiring, seen from the production entry point: budget, account accounting and the
 * no-dedupe-on-create rule are the three gaps that made the driver path unsafe to default-enable.
 */
function fakeTarget(o: { failTimes?: number; rateLimitHint?: boolean } = {}) {
  const calls: PublishStreamedInput[] = [];
  const finds: string[] = [];
  const REF = { targetId: "bilibili-upos", id: "BILIfake1" };
  let n = 0;
  const target: UploadTarget = {
    id: "bilibili-upos",
    platformIds: ["bilibili"],
    resolveCredential: () => ({ targetId: "bilibili-upos", locator: base.cookiesPath }),
    accountKey: () => "acct",
    hardPolicy: () => ({ visibility: "private", watermark: false, copyright: "self" }),
    defaults: () => ({ tid: 21, tags: [], titleMaxLength: 80, maxParts: null }),
    create: async () => ({ proof: "created", ref: REF }),
    append: async () => ({ proof: "observed" }),
    inspect: async () => ({ ref: REF, title: "t", partCount: 1 }) as ArchiveInfo,
    findRecent: async (input) => { finds.push(input.title); return "none"; },
    classifyError: (err): UploadErrorClass =>
      err instanceof FakeRateLimited
        // Default carries a 1ms hint so budget tests stay instant; rateLimitHint: false exercises
        // the real schedule (60s, 120s, ...) that the production wiring must supply.
        ? { kind: "rate-limited", ...(o.rateLimitHint === false ? {} : { retryAfterMs: 1 }) }
        : { kind: "permanent", reason: String(err) },
    capabilities: { appendGranularity: "single", seasons: false, streamPublish: true },
    publishStreamed: async (input): Promise<PublishStreamedResult> => {
      calls.push(input);
      n++;
      if (n <= (o.failTimes ?? 0)) throw new FakeRateLimited("code:21540");
      return input.ref ? { proof: "confirmed", ref: input.ref } : { proof: "created", ref: REF };
    },
  };
  return { target, calls, finds };
}

const ARCHIVE = { title: "T", tid: 21, tags: [], policy: { visibility: "private", watermark: false, copyright: "self" } as const };

function built(o: (Parameters<typeof fakeTarget>[0] & { submitGate?: { noteSubmit(): void; noteRateLimited(): void }; sleep?: (ms: number) => Promise<void> }) = {}) {
  const fake = fakeTarget(o);
  const sleeps: number[] = [];
  const s = buildLivePumpSubmitter({
    ...base,
    target: fake.target,
    sleep: o.sleep ?? (async (ms) => { sleeps.push(ms); }),
    ...(o.submitGate ? { submitGate: o.submitGate } : {}),
  });
  return { s, calls: fake.calls, finds: fake.finds, sleeps };
}

describe("live-pump submitter driver wiring", () => {
  it("retries a rate-limited publish five times, like the legacy path, before giving up", async () => {
    const spy = { events: [] as string[] };
    const { s, calls, sleeps } = built({
      failTimes: 6,
      submitGate: {
        noteSubmit: () => spy.events.push("submit"),
        noteRateLimited: () => spy.events.push("rate-limited"),
      },
    });
    await expect(s.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0", skipFindRecent: true }))
      .rejects.toMatchObject({ failure: "retry-exhausted" });
    // The legacy path allowed 5 attempts; the driver default (3) would give up two cooldowns early.
    expect(calls).toHaveLength(5);
    expect(spy.events.filter((e) => e === "submit")).toHaveLength(5);
    expect(spy.events.filter((e) => e === "rate-limited")).toHaveLength(5);
    expect(sleeps).toEqual([1, 1, 1, 1]);
  });

  it("records every attempt in the shared account window and cools it on a rate limit", async () => {
    const events: string[] = [];
    let n = 0;
    const fake = fakeTarget();
    const original = fake.target.publishStreamed!;
    (fake.target as { publishStreamed: UploadTarget["publishStreamed"] }).publishStreamed = async (input) => {
      n++;
      if (n === 1) throw new FakeRateLimited("code:21540");
      return original(input);
    };
    const s = buildLivePumpSubmitter({
      ...base,
      target: fake.target,
      sleep: async () => {},
      submitGate: {
        noteSubmit: () => events.push("submit"),
        noteRateLimited: () => events.push("rate-limited"),
      },
    });
    await s.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0", skipFindRecent: true });
    expect(events).toEqual(["submit", "rate-limited", "submit"]);
  });

  it("uses the legacy cooldown schedule when the target gives no hint", async () => {
    // Without an explicit retry block, the driver waits its own default (a flat 60s) at every
    // attempt — still inside the window Bilibili is holding. This is what the wiring prevents.
    const { s, calls, sleeps } = built({ failTimes: 2, rateLimitHint: false });
    await s.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0", skipFindRecent: true });
    expect(calls).toHaveLength(3);
    // 60s then 120s: the schedule grows, it is not a flat minute.
    expect(sleeps).toEqual([60_000, 120_000]);
  });

  it("passes skipFindRecent through, so a fresh create never adopts an older same-title archive", async () => {
    const { s, finds } = built();
    await s.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0", skipFindRecent: true });
    expect(finds).toEqual([]);

    const searched = built();
    await searched.s.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0" });
    expect(searched.finds).toEqual(["T"]);
  });

  it("a stop clears the pending cooldown timer instead of holding the process for it", async () => {
    // The driver settles on abort; the timer must go with it, or a stopped pump that already
    // reported its result keeps the child alive for the rest of a 60-300s cooldown.
    vi.useFakeTimers();
    const ac = new AbortController();
    const waited = abortableSleep(300_000, ac.signal);
    expect(vi.getTimerCount()).toBe(1);
    ac.abort();
    await waited;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a signal that already aborted never installs a timer", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    ac.abort();
    await abortableSleep(300_000, ac.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the timer normally when no signal aborts", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const waited = abortableSleep(300_000, ac.signal);
    await vi.advanceTimersByTimeAsync(300_000);
    await waited;
    expect(vi.getTimerCount()).toBe(0);
  });
});
