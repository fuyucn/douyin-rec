import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBiliupProcessor } from "../../packages/processors/src/biliup.js";

function job(files: string[], params: Record<string, unknown> = {}) {
  return {
    jobId: "biliup:k#g1", kind: "biliup", logicalKey: "k", generation: 1,
    inputs: files, params: { cookies: "c", title: "t", tid: 21, tag: "tag", public: false, ...params },
    replaceInputs: false, owner: { taskId: 1 }, createdAt: 1,
  } as never;
}
const ctx = () => ({ log() {}, alert() {}, markProgress() {}, assertLease() {}, signal: new AbortController().signal, setState: vi.fn() } as never);
function files(n = 2): string[] {
  const dir = mkdtempSync(join(tmpdir(), "bili-"));
  return Array.from({ length: n }, (_, i) => { const p = join(dir, `p${i}.mp4`); writeFileSync(p, "x"); return p; });
}

describe("biliup processor (plan 038 T08)", () => {
  it("appends one by one after creating P1 and returns the bv", async () => {
    const run = vi.fn(async (argv: string[]) => argv[2] === "upload" ? "BV1aaaaaaaaa" : "ok"); // issue-guard: allow (fake BV fixture)
    const p = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => "[]" } });
    const r = await p.run(job(files(2)), ctx());
    expect(r.bv).toBe("BV1aaaaaaaaa"); // issue-guard: allow (fake BV fixture)
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toContain("append");
  });

  it("an existing BV skips draft creation and only appends", async () => {
    const run = vi.fn(async () => "ok");
    const p = makeBiliupProcessor({ run });
    await p.run(job(files(1), { bv: "BV1bbbbbbbbb" }), ctx()); // issue-guard: allow (fake BV fixture)
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toContain("append");
  });

  it("no-draft proof yes -> refuse to create; unknown -> refuse (manual)", async () => {
    const run = vi.fn(async () => "BV1ccccccccc"); // issue-guard: allow (fake BV fixture)
    const yes = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async (a: string[]) => a.includes("--pubed") ? JSON.stringify([{ bvid: "BV1ccccccccc", title: "t", duration: 60 }]) : "[]" } }); // issue-guard: allow (fake BV fixture)
    await expect(yes.run(job(files(1)), ctx())).rejects.toThrow(/duplicate/);
    const unknown = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => { throw new Error("x"); } } });
    await expect(unknown.run(job(files(1)), ctx())).rejects.toThrow(/cannot confirm/);
  });

  it("an uncertain append outcome is marked ambiguous and not retried", async () => {
    const run = vi.fn(async (argv: string[]) => { if (argv[2] === "upload") return "BV1ddddddddd"; throw new Error("connection error start=1 end=2 uploader.rs:3"); }); // issue-guard: allow (fake BV fixture)
    const p = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => "[]" } });
    await expect(p.run(job(files(2)), ctx())).rejects.toThrow(/无法确认是否已提交|线路/);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.mock.calls.filter((c) => c[0].includes("append")).length).toBeGreaterThanOrEqual(1);
  });

  it("missing expected duration refuses creation (unknown is not no-draft)", async () => {
    const run = vi.fn(async () => "BV1eeeeeeeee"); // issue-guard: allow (fake BV fixture)
    await expect(makeBiliupProcessor({ run }).run(job(files(1)), ctx())).rejects.toThrow(/expected duration/);
    expect(run).not.toHaveBeenCalled();
  });

  it("a bv already in the table does not recreate P1 (resume)", async () => {
    const run = vi.fn(async () => "ok");
    const j = job(files(2)) as Record<string, unknown>;
    (j as { bv?: string }).bv = "BV1fffffffff"; // issue-guard: allow (fake BV fixture)
    const p = makeBiliupProcessor({ run });
    const r = await p.run(j as never, ctx());
    expect(r.bv).toBe("BV1fffffffff"); // issue-guard: allow (fake BV fixture)
    expect(run.mock.calls.every((c) => c[0].includes("append"))).toBe(true);
  });

  it("validate rejects missing cookies/title/tid/file", () => {
    expect(makeBiliupProcessor().validate(job(files(1), { cookies: "" }))).toMatch(/cookies/);
    expect(makeBiliupProcessor().validate(job(files(1), { title: "" }))).toMatch(/title/);
    expect(makeBiliupProcessor().validate(job(files(1), { tid: 0 }))).toMatch(/tid/);
    expect(makeBiliupProcessor().validate(job(["/nope.mp4"]))).toMatch(/does not exist/);
  });
});
