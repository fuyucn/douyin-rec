/**
 * The zero-disk submitter stays off unless the flag is set: a half-wired upload path is worse
 * than the legacy one (plans/049 stage 2b-2c).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ArchiveInfo, PublishStreamedInput, PublishStreamedResult, UploadErrorClass, UploadTarget } from "@drec/core";
import { abortableSleep, buildLivePumpSubmitter } from "./live-pump-submitter.js";

afterEach(() => { vi.useRealTimers(); });

const base = {
  cookiesPath: "/tmp/cookies.json",
  spoolDir: "/tmp/spool",
  pumpRoom: "r",
};

describe("buildLivePumpSubmitter", () => {
  it("returns null when the flag is off", () => {
    const s = buildLivePumpSubmitter({ ...base, env: () => undefined });
    expect(s).toBeNull();
  });

  it("returns the three operations when the flag is on", () => {
    const s = buildLivePumpSubmitter({ ...base, env: (k) => (k === "DREC_LIVE_PUMP_DRIVER" ? "1" : undefined) });
    expect(s).not.toBeNull();
    expect(typeof s!.ensureStreamedArchive).toBe("function");
    expect(typeof s!.appendStreamedPart).toBe("function");
    expect(typeof s!.verify).toBe("function");
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
    env: (k) => (k === "DREC_LIVE_PUMP_DRIVER" ? "1" : undefined),
    target: fake.target,
    sleep: o.sleep ?? (async (ms) => { sleeps.push(ms); }),
    ...(o.submitGate ? { submitGate: o.submitGate } : {}),
  });
  return { s: s!, calls: fake.calls, finds: fake.finds, sleeps };
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
      env: (k) => (k === "DREC_LIVE_PUMP_DRIVER" ? "1" : undefined),
      target: fake.target,
      sleep: async () => {},
      submitGate: {
        noteSubmit: () => events.push("submit"),
        noteRateLimited: () => events.push("rate-limited"),
      },
    });
    await s!.ensureStreamedArchive({ archive: ARCHIVE, name: "stem0", skipFindRecent: true });
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
