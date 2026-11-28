/**
 * live-pump submitter seam (plans/049 stage 2b-2c): the streaming runner hands its parts to an
 * injected PartSubmitter, which only publishes metadata - the bytes are already on the archive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveRef, PartSubmitter } from "@drec/core";
import { LivePumpSession, livePumpStatePath, readLivePumpState } from "./live-pump.js";

const REF: ArchiveRef = { targetId: "bilibili-upos", id: "BILIfake1" };

interface Calls {
  ensure: Array<Parameters<PartSubmitter["ensureStreamedArchive"]>[0]>;
  append: Array<Parameters<PartSubmitter["appendStreamedPart"]>[0]>;
}

function fakeSubmitter(mode: "ok" | "needs-manual" | "retry-exhausted" = "ok"): { submitter: PartSubmitter; calls: Calls } {
  const calls: Calls = { ensure: [], append: [] };
  const fail = (): never => {
    const err = new Error("archive outcome unknown") as Error & { failure?: string };
    err.name = "UploadDriverError";
    err.failure = mode === "needs-manual" ? "needs-manual" : "retry-exhausted";
    throw err;
  };
  return {
    calls,
    submitter: {
      ensureStreamedArchive: async (req) => {
        calls.ensure.push(req);
        if (mode !== "ok") fail();
        return { ref: REF, reused: false, partProof: "observed" };
      },
      appendStreamedPart: async (req) => {
        calls.append.push(req);
        if (mode !== "ok") fail();
        return { confirmed: [1], accepted: [] };
      },
      observeStreamedPart: () => {},
      verify: async () => ({ ok: true, observedParts: null }),
    },
  };
}

describe("live-pump -> PartSubmitter seam", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-submitter-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const session = (submitter: PartSubmitter, spoolDir = dir, submitterTargetId?: string) => new LivePumpSession({
    cookiesPath: join(spoolDir, "cookies.json"),
    room: "r",
    spoolDir,
    title: "测试-1",
    tid: 21,
    tag: "x,,y",
    desc: "test description",
    private: true,
    submitter,
    submitterTargetId,
    cleanupConfirmedSpool: true,
  });

  it("P1 publishes the stem through ensureStreamedArchive and records the archive id", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const publish = submitter.ensureStreamedArchive;
    submitter.ensureStreamedArchive = async (request) => {
      expect(readLivePumpState(livePumpStatePath(dir, "r"))?.pending)
        .toMatchObject({ kind: "create", partIndex: 0, stem: "stem0", spoolPath: spool });
      expect(existsSync(spool)).toBe(true);
      return publish(request);
    };
    const title = "P1".repeat(50);
    const signal = new AbortController().signal;
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title, bytes: 6, durationSec: 10.6 }, signal);
    expect(r.ok).toBe(true);
    expect(s.bvid).toBe("BILIfake1");
    expect(calls.ensure).toHaveLength(1);
    expect(calls.append).toHaveLength(0);
    expect(calls.ensure[0]).toEqual({
      archive: { title: "测试-1", tid: 21, tags: ["x", "y"], desc: "test description",
        policy: { visibility: "private", watermark: false, copyright: "self" } },
      name: "stem0", title: title.slice(0, 80), expectedDurationSec: 11, skipFindRecent: true, signal,
    });
    expect(calls.ensure[0]!.signal).toBe(signal);
    expect(s.parts.map((p) => p.confirmed)).toEqual([true]);
    expect(readLivePumpState(livePumpStatePath(dir, "r"))).toMatchObject({
      bvid: REF.id, parts: [{ stem: "stem0", confirmed: true }],
    });
    expect(existsSync(spool)).toBe(false);
  });

  it("serializes concurrent submits for the same fresh part", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ensureAttempts = 0;
    const ensure = submitter.ensureStreamedArchive;
    submitter.ensureStreamedArchive = async (request) => {
      ensureAttempts += 1;
      await gate;
      return ensure(request);
    };
    const input = { index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 };
    const first = s.submitPart(input);
    const second = s.submitPart(input);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // Without the submission lock both callers reach ensureStreamedArchive before the gate opens.
    expect(ensureAttempts).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok, a.error ?? "").toBe(true);
    expect(b.ok, b.error ?? "").toBe(true);
    expect(calls.ensure).toHaveLength(1);
    expect(s.parts.filter((p) => p.confirmed)).toHaveLength(1);
  });

  it("P2 appends to the archive the submitter created", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter, dir, "custom-target");
    const signal = new AbortController().signal;
    const title = "Part title".repeat(10);
    const append = submitter.appendStreamedPart;
    submitter.appendStreamedPart = async (request) => {
      expect(readLivePumpState(livePumpStatePath(dir, "r"))).toMatchObject({
        bvid: REF.id, pending: { kind: "append", partIndex: 1, stem: "stem1" },
        parts: [{ stem: "stem0", confirmed: true }],
      });
      expect(existsSync(join(dir, "p1.ts"))).toBe(true);
      return append(request);
    };
    for (let i = 0; i < 2; i++) {
      const spool = join(dir, "p" + i + ".ts");
      writeFileSync(spool, "part-" + i);
      const r = await s.submitPart({ index: i, spoolPath: spool, stem: "stem" + i, title, bytes: 6, durationSec: 10 }, signal);
      expect(r.ok).toBe(true);
    }
    expect(calls.ensure).toHaveLength(1);
    expect(calls.append).toHaveLength(1);
    expect(calls.append[0]).toEqual({
      ref: { targetId: "custom-target", id: REF.id }, name: "stem1", title: title.slice(0, 80), size: 6, signal,
    });
    expect(calls.append[0]!.signal).toBe(signal);
    expect(s.parts.map((p) => p.confirmed)).toEqual([true, true]);
  });

  it("driver failures preserve the spool and WAL without runner retries", async () => {
    for (const failure of ["needs-manual", "retry-exhausted"] as const) {
      const spoolDir = join(dir, failure);
      const { submitter, calls } = fakeSubmitter(failure);
      const s = session(submitter, spoolDir);
      const spool = join(spoolDir, "p0.ts");
      writeFileSync(spool, "part-0");
      const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
      expect(r.ok, failure).toBe(false);
      expect(r.needsManual, failure).toBe(failure === "needs-manual" ? true : undefined);
      expect(r.retryable, failure).toBe(failure === "retry-exhausted" ? true : undefined);
      expect(r.error).toBe("archive outcome unknown");
      expect(calls.ensure).toHaveLength(1);
      expect(calls.append).toHaveLength(0);
      expect(existsSync(spool)).toBe(true);
      // Read the WAL the next start recovers; an empty in-memory list proves nothing.
      const state = readLivePumpState(livePumpStatePath(spoolDir, "r"));
      expect(state).not.toBeNull();
      expect(state!.pending).toMatchObject({ kind: "create", partIndex: 0, stem: "stem0", spoolPath: spool });
      expect(state!.parts.some((p) => p.confirmed)).toBe(false);
      expect(s.bvid).toBeUndefined();
    }
  });

  it("the first part asks the submitter to create, never to adopt an older same-title archive", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "", bytes: 6, durationSec: 0 });
    // The legacy path only dedupes by title during crash recovery; a live title template can render
    // the same title twice in a day, and adopting the first archive would mix two broadcasts.
    expect(calls.ensure[0]!.skipFindRecent).toBe(true);
    expect(calls.ensure[0]).not.toHaveProperty("title");
    expect(calls.ensure[0]).not.toHaveProperty("expectedDurationSec");
  });
});
