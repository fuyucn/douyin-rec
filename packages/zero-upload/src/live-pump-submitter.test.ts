/**
 * live-pump submitter seam (plans/049 stage 2b): the streaming runner must hand its parts to an
 * injected PartSubmitter when one is configured, and must keep the WAL honest when it refuses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveRef, PartSubmitter, UploadFile, UploadPolicy } from "@drec/core";
import { LivePumpSession } from "./live-pump.js";

const REF: ArchiveRef = { targetId: "bilibili-upos", id: "BILIfake1" };

interface Calls {
  ensure: Array<{ title: string; files: UploadFile[]; policy: UploadPolicy }>;
  append: Array<{ ref: ArchiveRef; files: UploadFile[] }>;
}

function fakeSubmitter(mode: "ok" | "needs-manual" | "transient" = "ok"): { submitter: PartSubmitter; calls: Calls } {
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
      ensureArchive: async (req) => {
        calls.ensure.push(req);
        if (mode !== "ok") fail();
        return { ref: REF, reused: false };
      },
      appendParts: async (req) => {
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

  it("P1 creates through the submitter and records the returned archive id", async () => {
    const { submitter, calls } = fakeSubmitter();
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    expect(r.ok).toBe(true);
    expect(s.bvid).toBe("BILIfake1");
    expect(calls.ensure).toHaveLength(1);
    expect(calls.append).toHaveLength(0);
    expect(calls.ensure[0]!.policy.visibility).toBe("private");
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

  it("a refused submit is never retried by the runner", async () => {
    const { submitter, calls } = fakeSubmitter("transient");
    const s = session(submitter);
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "part-0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 6, durationSec: 10 });
    expect(r.ok).toBe(false);
    expect(calls.ensure).toHaveLength(1);
  });
});
