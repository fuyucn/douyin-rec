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
  it("建稿 P1 后逐条 append,返回 bv", async () => {
    const run = vi.fn(async (argv: string[]) => argv[2] === "upload" ? "BV1aaaaaaaaa" : "ok");
    const p = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => "[]" } });
    const r = await p.run(job(files(2)), ctx());
    expect(r.bv).toBe("BV1aaaaaaaaa");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toContain("append");
  });

  it("已有 BV → 不再建稿,只 append", async () => {
    const run = vi.fn(async () => "ok");
    const p = makeBiliupProcessor({ run });
    await p.run(job(files(1), { bv: "BV1bbbbbbbbb" }), ctx());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toContain("append");
  });

  it("无稿证明 yes → 拒绝建稿;unknown → 拒绝(转人工)", async () => {
    const run = vi.fn(async () => "BV1ccccccccc");
    const yes = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async (a: string[]) => a.includes("--pubed") ? JSON.stringify([{ bvid: "BV1ccccccccc", title: "t", duration: 60 }]) : "[]" } });
    await expect(yes.run(job(files(1)), ctx())).rejects.toThrow(/拒绝重复建稿/);
    const unknown = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => { throw new Error("x"); } } });
    await expect(unknown.run(job(files(1)), ctx())).rejects.toThrow(/无法确认/);
  });

  it("append 结果不确定 → 标记 ambiguous,不重试", async () => {
    const run = vi.fn(async (argv: string[]) => { if (argv[2] === "upload") return "BV1ddddddddd"; throw new Error("connection error start=1 end=2 uploader.rs:3"); });
    const p = makeBiliupProcessor({ run, expectedDurationSec: 60, lookup: { run: async () => "[]" } });
    await expect(p.run(job(files(2)), ctx())).rejects.toThrow(/无法确认是否已提交|线路/);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.mock.calls.filter((c) => c[0].includes("append")).length).toBeGreaterThanOrEqual(1);
  });

  it("缺少预期时长 → 拒绝建稿(不能把未知当无稿)", async () => {
    const run = vi.fn(async () => "BV1eeeeeeeee");
    await expect(makeBiliupProcessor({ run }).run(job(files(1)), ctx())).rejects.toThrow(/预期时长/);
    expect(run).not.toHaveBeenCalled();
  });

  it("表里已有 bv → 不重建 P1(续跑)", async () => {
    const run = vi.fn(async () => "ok");
    const j = job(files(2)) as Record<string, unknown>;
    (j as { bv?: string }).bv = "BV1fffffffff";
    const p = makeBiliupProcessor({ run });
    const r = await p.run(j as never, ctx());
    expect(r.bv).toBe("BV1fffffffff");
    expect(run.mock.calls.every((c) => c[0].includes("append"))).toBe(true);
  });

  it("validate:缺 cookies/title/tid/file 被拒", () => {
    expect(makeBiliupProcessor().validate(job(files(1), { cookies: "" }))).toMatch(/cookies/);
    expect(makeBiliupProcessor().validate(job(files(1), { title: "" }))).toMatch(/标题/);
    expect(makeBiliupProcessor().validate(job(files(1), { tid: 0 }))).toMatch(/tid/);
    expect(makeBiliupProcessor().validate(job(["/nope.mp4"]))).toMatch(/不存在/);
  });
});
