// plan 046 §5.4: upload-part — one part, explicit bv/ack + byte/fp proof; no B 站查询、无目录扫描。
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, statSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPEND_AMBIGUOUS_MARKER, PART_KINDS, jobIdOf, type ProcessContext, type ProcessJob, type PartCtx,
} from "@drec/core";
import { makeUploadPartProcessor, shouldChainCleanup, PART_WORKFLOW_PARAM, uploadPartProcessor } from "@drec/processors";

let dir: string;
const setup = (): void => { dir = mkdtempSync(join(tmpdir(), "upload-part-")); };
const teardown = (): void => rmSync(dir, { recursive: true, force: true });
const put = (name = "a_000.ts", body = "1234567890"): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
const fp = (p: string): { size: number; mtimeMs: number } => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; };
const ctxOf = (file: string, bv?: string): PartCtx => ({
  v: 1, orderKey: "same-broadcast", index: 1, file, fp: fp(file), ...(bv ? { bv } : {}),
});
const job = (file: string, over: Partial<ProcessJob> = {}): ProcessJob => {
  const logicalKey = "same-broadcast:part-1";
  const params = { ctx: ctxOf(file), cookies: "c", title: "t", tid: 21, tag: "tag", public: false, ...(over.params ?? {}) };
  return {
    jobId: jobIdOf(PART_KINDS.upload, logicalKey, 1), kind: PART_KINDS.upload, logicalKey, generation: 1,
    inputs: [file], replaceInputs: false, owner: { taskId: 1 }, createdAt: 1,
    ...over, params,
  };
};
const pc = (): ProcessContext => ({
  signal: new AbortController().signal, assertLease: () => {}, markProgress: () => {},
  log: () => {}, alert: () => {}, setState: vi.fn(),
});
// Default run seam: emits "All files uploaded successfully" and a fake bv for create.
const BV = "BV1" + "a".repeat(9); // parseBV expects BV + 10 chars
const ackedRun = (ackedBytes: number) => vi.fn(async (argv: string[]) => {
  if (argv[2] === "upload") return "All files uploaded successfully\n" + BV;
  return "All files uploaded successfully\nok";
});

interface Seam {
  run: ReturnType<typeof ackedRun>;
  readAcked: () => Map<string, number>;
}
const seams = (ackedBytes = 20): Seam => ({
  run: ackedRun(ackedBytes),
  readAcked: () => new Map([["local>peer", ackedBytes]]),
});
const processor = (s: Seam, extra: Record<string, unknown> = {}) => makeUploadPartProcessor({
  run: s.run as never, readAcked: s.readAcked, tickMs: 1, now: () => 1_000_000,
  expectedDurationSec: 60, lookup: { run: async () => "[]", trustNo: true },
  ...extra,
});

describe("upload-part processor", () => {
  it("contract table + workflow template decisions", () => {
    setup();
    expect(uploadPartProcessor).toMatchObject({ kind: PART_KINDS.upload, resource: "upload", lane: "biliup", retryable: false, interruptible: false });
    const f = put();
    expect(shouldChainCleanup(job(f))).toBe(false); // 缺省不链出
    expect(shouldChainCleanup(job(f, { params: { [PART_WORKFLOW_PARAM]: "rolling" } }))).toBe(true);
    expect(shouldChainCleanup(job(f, { params: { [PART_WORKFLOW_PARAM]: "live-pump" } }))).toBe(true);
    expect(shouldChainCleanup(job(f, { params: { [PART_WORKFLOW_PARAM]: "whole-order" } }))).toBe(false);
    expect(shouldChainCleanup(job(f, { params: { [PART_WORKFLOW_PARAM]: "nonsense" } }))).toBe(false);
    teardown();
  });

  it("create returns explicit bv/confirmation; append uses ctx.bv and never creates", async () => {
    setup();
    try {
      const f = put();
      const s = seams();
      const p = processor(s);
      const r = await p.run(job(f), pc());
      expect(r.bv).toBe(BV);
      expect(r.confirmed).toMatchObject({ size: fp(f).size });
      expect(r.confirmed!.ackedBytes).toBeGreaterThanOrEqual(r.confirmed!.size);
      expect(s.run.mock.calls[0]![0]).toContain("upload");
      teardown();

      setup();
      const f2 = put();
      const s2 = seams();
      const r2 = await processor(s2).run(job(f2, { params: { ctx: ctxOf(f2, "INHERITED") } }), pc());
      expect(r2.bv).toBe("INHERITED");
      expect(s2.run.mock.calls[0]![0]).toContain("append");
      expect(s2.run).toHaveBeenCalledTimes(1);
    } finally { teardown(); }
  });

  it("validate rejects non-video, missing metadata, bad ctx, and mismatched inputs", () => {
    setup();
    try {
      const f = put();
      const p = processor(seams());
      expect(p.validate(job(f))).toBeNull();
      expect(p.validate(job(f, { inputs: [f, put("b.ts")] }))).toMatch(/exactly one/);
      expect(p.validate(job(f, { inputs: [put("a.xml")] }))).toMatch(/video/);
      expect(p.validate(job(f, { params: { ctx: { ...ctxOf(f), file: "a_000.ts" } } }))).toMatch(/ctx/);
      expect(p.validate(job(f, { params: { cookies: "" } }))).toMatch(/metadata/);
      expect(p.validate(job(f, { params: { ctx: { ...ctxOf(f), fp: { size: 0, mtimeMs: 0 } } } }))).toBeNull(); // fp shape ok; run compares
    } finally { teardown(); }
  });

  it("no file-complete boundary means the byte proof is missing and success is refused", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      const s = seams(200);
      const p = processor(s, { run: async () => BV });
      await expect(p.run(job(f), pc())).rejects.toThrow(/explicit transfer ack/);
    } finally { teardown(); }
  });

  it("acked bytes below the file size is NOT success even with an explicit boundary", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      const s = seams(0);
      await expect(processor(s).run(job(f), pc())).rejects.toThrow(/acked bytes 0 < file size 100/);
    } finally { teardown(); }
  });

  it("a changed fingerprint after transfer is NOT success", async () => {
    setup();
    try {
      const f = put();
      const original = fp(f);
      const s = seams();
      const p = processor(s, {
        run: async (argv: string[]) => { writeFileSync(f, "replaced-after-seal"); return argv[2] === "upload" ? BV : "All files uploaded successfully\nok"; },
      });
      await expect(p.run(job(f), pc())).rejects.toThrow(/fp changed/);
      expect(original.size).toBe(10);
    } finally { teardown(); }
  });

  it("append ambiguity is NOT success and never returns a bv", async () => {
    setup();
    try {
      const f = put();
      const s = seams();
      const p = processor(s, {
        run: async () => { throw new Error(APPEND_AMBIGUOUS_MARKER + " append not confirmed"); },
      });
      await expect(p.run(job(f, { params: { ctx: ctxOf(f, "INHERITED") } }), pc()))
        .rejects.toThrow(/upload-part append outcome unknown; no confirmation, no cleanup chain/);
    } finally { teardown(); }
  });

  it("no explicit all-files-uploaded ack is NOT success", async () => {
    setup();
    try {
      const f = put();
      const s = seams();
      const p = processor(s, { run: async () => BV });
      await expect(p.run(job(f), pc())).rejects.toThrow(/explicit transfer ack/);
    } finally { teardown(); }
  });

  it("mtime-only drift after seal is NOT success", async () => {
    setup();
    try {
      const f = put();
      const s = seams();
      const p = processor(s, {
        run: async (argv: string[]) => { utimesSync(f, new Date(1_700_000_000), new Date(1_700_000_000)); return argv[2] === "upload" ? "All files uploaded successfully\n" + BV : "All files uploaded successfully\nok"; },
      });
      await expect(p.run(job(f), pc())).rejects.toThrow(/fp changed/);
    } finally { teardown(); }
  });
});
