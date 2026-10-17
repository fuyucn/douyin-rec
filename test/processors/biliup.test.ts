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

  const withRowBv = (n: number) => {
    const j = job(files(n)) as Record<string, unknown>;
    (j as { bv?: string }).bv = "BV1fffffffff"; // issue-guard: allow (fake BV fixture)
    return j;
  };

  it("a bv already in the table resumes appending from the confirmed part count", async () => {
    const run = vi.fn(async () => "ok");
    const j = withRowBv(4);
    const p = makeBiliupProcessor({ run, countParts: async () => 2 });
    const r = await p.run(j as never, ctx());
    expect(r.bv).toBe("BV1fffffffff"); // issue-guard: allow (fake BV fixture)
    // P1 and P2 are already on the archive: only the files at index 2 and 3 are appended, never P1 again.
    const appended = run.mock.calls.map((c) => c[0] as string[]);
    expect(appended.every((a) => a.includes("append"))).toBe(true);
    expect(appended).toHaveLength(2);
    expect(appended[0]!.join(" ")).toContain((j as { inputs: string[] }).inputs[2]);
    expect(appended[1]!.join(" ")).toContain((j as { inputs: string[] }).inputs[3]);
  });

  it("a resumed job with an unknown part count fails closed and appends nothing", async () => {
    const run = vi.fn(async () => "ok");
    for (const count of [null, 0, 99]) {
      await expect(makeBiliupProcessor({ run, countParts: async () => count }).run(withRowBv(3) as never, ctx()))
        .rejects.toThrow(/cannot confirm how many parts/);
    }
    // No counter available at all (injected run, no countParts) is also unknown.
    await expect(makeBiliupProcessor({ run }).run(withRowBv(3) as never, ctx())).rejects.toThrow(/cannot confirm how many parts/);
    expect(run).not.toHaveBeenCalled();
  });

  it("a resumed job whose parts are all on the archive appends nothing", async () => {
    const run = vi.fn(async () => "ok");
    const r = await makeBiliupProcessor({ run, countParts: async () => 3 }).run(withRowBv(3) as never, ctx());
    expect(r.bv).toBe("BV1fffffffff"); // issue-guard: allow (fake BV fixture)
    expect(run).not.toHaveBeenCalled();
  });

  it("params.bv still appends every input (all inputs are parts to append)", async () => {
    const run = vi.fn(async () => "ok");
    await makeBiliupProcessor({ run }).run(job(files(2), { bv: "BV1ggggggggg" }) as never, ctx()); // issue-guard: allow (fake BV fixture)
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a failed append is checked against the part count: grown count means it was accepted", async () => {
    let n = 1;
    const run = vi.fn(async (argv: string[]) => {
      if (argv.includes("append")) { n = 2; throw new Error("error sending request start=0 end=1 uploader.rs:1"); }
      return "BV1hhhhhhhhh"; // issue-guard: allow (fake BV fixture)
    });
    const countParts = vi.fn(async () => n);
    const lookup = { run: async () => "[]" };
    const r = await makeBiliupProcessor({ run, countParts, lookup, expectedDurationSec: 60 }).run(job(files(2)), ctx());
    expect(r.bv).toBe("BV1hhhhhhhhh"); // issue-guard: allow (fake BV fixture)
    // The append reached the server although the client saw an error: it must not be retried on another line.
    expect(run.mock.calls.filter((c) => (c[0] as string[]).includes("append"))).toHaveLength(1);
  });

  it("validate rejects missing cookies/title/tid/file", () => {
    expect(makeBiliupProcessor().validate(job(files(1), { cookies: "" }))).toMatch(/cookies/);
    expect(makeBiliupProcessor().validate(job(files(1), { title: "" }))).toMatch(/title/);
    expect(makeBiliupProcessor().validate(job(files(1), { tid: 0 }))).toMatch(/tid/);
    expect(makeBiliupProcessor().validate(job(["/nope.mp4"]))).toMatch(/does not exist/);
  });
});
