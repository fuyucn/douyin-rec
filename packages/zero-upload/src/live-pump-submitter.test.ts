/**
 * live-pump submitter seam (plans/049 stage 2b-2c): the streaming runner hands its parts to an
 * injected PartSubmitter, which only publishes metadata - the bytes are already on the archive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveRef, PartSubmitter, SubmitArchiveMeta } from "@drec/core";
import { LivePumpSession } from "./live-pump.js";

const REF: ArchiveRef = { targetId: "bilibili-upos", id: "BILIfake1" };

interface Calls {
  ensure: Array<{ archive: SubmitArchiveMeta; name: string; title?: string; skipFindRecent?: boolean }>;
  append: Array<{ ref: ArchiveRef; name: string; title?: string }>;
}

function fakeSubmitter(mode: "ok" | "needs-manual" = "ok"): { submitter: PartSubmitter; calls: Calls } {
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
        return { ref: REF, reused: false };
      },
      appendStreamedPart: async (req) => {
        calls.append.push(req);
        if (mode !== "ok") fail();
        return { confirmed: [1] };
      },
      verify: async () => ({ ok: true, observedParts: null }),
    },
  };
}

describe("live-pump -> PartSubmitter seam", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-submitter-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const session = (submitter: PartSubmitter) => new LivePumpSession({
    cookiesPath: join(dir, "cookies.json"),
    room: "r",
    spoolDir: dir,
    title: "测试-1",
    tid: 21,
    tag: "x",
    private: true,
    submitter,
    cleanupConfirmedSpool: true,
  });

  it("P1 publishes the stem through ensureStreamedArchive and records the archive id", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    expect(r.ok).toBe(true);
    expect(s.bvid).toBe("BILIfake1");
    expect(calls.ensure).toHaveLength(1);
    expect(calls.append).toHaveLength(0);
    expect(calls.ensure[0]!.name).toBe("stem0");
    expect(calls.ensure[0]!.archive.policy?.visibility).toBe("private");
    expect(calls.ensure[0]!.archive.tid).toBe(21);
    expect(s.parts.map((p) => p.confirmed)).toEqual([true]);
    expect(existsSync(spool)).toBe(false);
  });

  it("P2 appends to the archive the submitter created", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    for (let i = 0; i < 2; i++) {
      const spool = join(dir, "p" + i + ".ts");
      writeFileSync(spool, "part-" + i);
      const r = await s.submitPart({ index: i, spoolPath: spool, stem: "stem" + i, title: "P" + (i + 1), bytes: 6, durationSec: 10 });
      expect(r.ok).toBe(true);
    }
    expect(calls.ensure).toHaveLength(1);
    expect(calls.append).toHaveLength(1);
    expect(calls.append[0]!.ref).toEqual(REF);
    expect(calls.append[0]!.name).toBe("stem1");
    expect(s.parts.map((p) => p.confirmed)).toEqual([true, true]);
  });

  it("needs-manual keeps the spool, the WAL entry and the part unconfirmed", async () => {
    const { submitter, calls } = fakeSubmitter("needs-manual");
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    expect(r.ok).toBe(false);
    expect(r.needsManual).toBe(true);
    expect(calls.ensure).toHaveLength(1);
    expect(existsSync(spool)).toBe(true);
    expect(s.parts.every((p) => !p.confirmed)).toBe(true);
    expect(s.bvid).toBeUndefined();
  });

  it("a refused publish is never retried by the runner", async () => {
    const { submitter, calls } = fakeSubmitter("needs-manual");
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    expect(r.ok).toBe(false);
    expect(calls.ensure).toHaveLength(1);
  });

  it("the first part asks the submitter to create, never to adopt an older same-title archive", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    // The legacy path only dedupes by title during crash recovery; a live title template can render
    // the same title twice in a day, and adopting the first archive would mix two broadcasts.
    expect(calls.ensure[0]!.skipFindRecent).toBe(true);
  });
});
