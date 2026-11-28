// plan 059 P0a: unqualified cleanup consumers retain legacy sources and upload aliases.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PART_KINDS, jobIdOf, type ProcessContext, type ProcessJob } from "@drec/core";
import {
  cleanupPartProcessor, makeCleanupPartProcessor, uploadAliasPath, UPLOAD_ALIAS_DIR,
} from "@drec/processors";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cleanup-part-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (name: string, body = "x"): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
const fpOf = (p: string): { size: number; mtimeMs: number } => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; };
const putAlias = (file: string): string => {
  const alias = uploadAliasPath(file);
  mkdirSync(join(dir, UPLOAD_ALIAS_DIR), { recursive: true });
  linkSync(file, alias);
  return alias;
};

interface JobOver {
  ctx?: unknown | null; inputs?: string[]; replaceInputs?: boolean;
  orderKey?: string | null; seq?: number | null;
}
const job = (file: string, over: JobOver = {}): ProcessJob => {
  const ctx = over.ctx === null
    ? undefined
    : over.ctx ?? { v: 1, orderKey: "same-broadcast", index: 1, file, fp: fpOf(file), bv: "DRAFT-1" };
  const logicalKey = "same-broadcast:part-1";
  return {
    jobId: jobIdOf(PART_KINDS.cleanup, logicalKey, 1), kind: PART_KINDS.cleanup, logicalKey, generation: 1,
    inputs: over.inputs ?? [file], params: { ctx }, replaceInputs: over.replaceInputs ?? false,
    owner: { taskId: 1 }, createdAt: 1, orderKey: over.orderKey ?? null, seq: over.seq ?? null,
  };
};
const runCtx = (over: Partial<ProcessContext> = {}): ProcessContext => ({
  signal: new AbortController().signal, assertLease: () => {}, markProgress: () => {},
  log: () => {}, alert: () => {}, ...over,
});
const okJob = (): { file: string; j: ProcessJob } => {
  const file = put("a_000.ts");
  return { file, j: job(file) };
};

describe("cleanup-part contract table", () => {
  it("keeps the cleanup lane but refuses automatic retries without a qualified executor", () => {
    expect(cleanupPartProcessor.kind).toBe(PART_KINDS.cleanup);
    expect(cleanupPartProcessor.resource).toBe("cpu");
    expect(cleanupPartProcessor.lane).toBe("copy");
    expect(cleanupPartProcessor.retryable).toBe(false);
    expect(cleanupPartProcessor.interruptible).toBe(true);
  });

  it("validate holds a canonical legacy v1 ctx even without a protection marker", () => {
    const { file, j: legacyJob } = okJob();
    const alias = putAlias(file);
    const before = JSON.stringify(legacyJob);
    const error = cleanupPartProcessor.validate(legacyJob);
    expect(error).toMatch(/no qualified per-part observation executor/i);
    expect(error).toMatch(/manual/i);
    expect(JSON.stringify(legacyJob)).toBe(before);
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("validate rejects anything that could point the delete at another file", () => {
    const file = put("a_000.ts");
    const bad: Array<[string, ProcessJob]> = [
      ["two inputs", job(file, { inputs: [file, join(dir, "b_001.ts")] })],
      ["relative ctx file", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file: "a_000.ts", fp: fpOf(file), bv: "B" } })],
      ["xml ctx file", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file: join(dir, "a.xml"), fp: fpOf(file), bv: "B" }, inputs: [join(dir, "a.xml")] })],
      ["ass input", job(file, { inputs: [put("a.ass")] })],
      ["session sidecar input", job(file, { inputs: [put("a.session.json")] })],
      ["replaceInputs", job(file, { replaceInputs: true })],
      ["orderKey", job(file, { orderKey: "o" })],
      ["seq", job(file, { seq: 2 })],
      ["missing ctx", job(file, { ctx: null })],
      ["wrong ctx version", job(file, { ctx: { v: 2, orderKey: "o", index: 1, file, fp: fpOf(file), bv: "B" } })],
      ["empty orderKey", job(file, { ctx: { v: 1, orderKey: "", index: 1, file, fp: fpOf(file), bv: "B" } })],
      ["zero index", job(file, { ctx: { v: 1, orderKey: "o", index: 0, file, fp: fpOf(file), bv: "B" } })],
      ["ctx file != inputs[0]", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file: join(dir, "other_001.ts"), fp: fpOf(file), bv: "B" } })],
      ["missing fp", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file } })],
      ["negative fp size", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file, fp: { size: -1, mtimeMs: 1 }, bv: "B" } })],
      ["empty bv", job(file, { ctx: { v: 1, orderKey: "o", index: 1, file, fp: fpOf(file), bv: "" } })],
    ];
    for (const [label, j] of bad) expect(cleanupPartProcessor.validate(j), label).not.toBeNull();
    const sidecar = put("a.session.json");
    expect(cleanupPartProcessor.validate(job(file, { inputs: [sidecar] }))).toMatch(/视频文件/);
  });

  it("validate honours injected allowedRoots (fail-closed outside)", () => {
    const file = put("a_000.ts");
    const outside = "/other/root/a_000.ts";
    const p = makeCleanupPartProcessor({ allowedRoots: () => [dir] });
    const j: ProcessJob = {
      ...job(file),
      jobId: jobIdOf(PART_KINDS.cleanup, "o:part-1", 1), logicalKey: "o:part-1",
      inputs: [outside],
      params: { ctx: { v: 1, orderKey: "o", index: 1, file: outside, fp: { size: 1, mtimeMs: 1 }, bv: "B" } },
    };
    expect(p.validate(j)).toMatch(/allowedRoots/);
  });
});

describe("cleanup-part run", () => {
  it("rejects direct run before existence, stat, lease or unlink and retains both hardlinks", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const legacyJob = job(file);
    const before = JSON.stringify(legacyJob);
    const exists = vi.fn(() => true);
    const stat = vi.fn(() => fpOf(file));
    const unlink = vi.fn();
    const assertLease = vi.fn();
    const alert = vi.fn();
    const processor = makeCleanupPartProcessor({ exists, stat, unlink });
    await expect(processor.run(legacyJob, runCtx({ assertLease, alert }))).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(assertLease).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(JSON.stringify(legacyJob)).toBe(before);
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("retains the source when no alias exists", async () => {
    const file = put("a_000.ts");
    await expect(cleanupPartProcessor.run(job(file), runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(readFileSync(file, "utf-8")).toBe("x");
  });

  it("retains a replaced source and its alias without treating a fingerprint mismatch as permission", async () => {
    const legacyJob = job(put("a_000.ts"));
    const file = legacyJob.inputs[0]!;
    const alias = putAlias(file);
    writeFileSync(file, "content replaced after sealing");
    await expect(cleanupPartProcessor.run(legacyJob, runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(readFileSync(file, "utf-8")).toBe("content replaced after sealing");
    expect(readFileSync(alias, "utf-8")).toBe("content replaced after sealing");
  });

  it("retains the source and alias after an mtime change", async () => {
    const legacyJob = job(put("a_000.ts"));
    const file = legacyJob.inputs[0]!;
    const alias = putAlias(file);
    utimesSync(file, new Date(1_700_000_000), new Date(1_700_000_000));
    await expect(cleanupPartProcessor.run(legacyJob, runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("does not report idempotent success when only the upload alias remains", async () => {
    const legacyJob = job(put("a_000.ts"));
    const file = legacyJob.inputs[0]!;
    const alias = putAlias(file);
    const exists = vi.fn(() => false);
    const stat = vi.fn(() => { throw new Error("Unexpected source stat"); });
    const unlink = vi.fn();
    const processor = makeCleanupPartProcessor({ exists, stat, unlink });
    rmSync(file);
    await expect(processor.run(legacyJob, runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("holds unproved work before consulting even a lost lease", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const unlink = vi.fn();
    const assertLease = vi.fn(() => { throw new Error("lease lost"); });
    const processor = makeCleanupPartProcessor({ unlink });
    await expect(processor.run(job(file), runCtx({ assertLease }))).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(assertLease).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("never reaches an alias unlink failure while proof is missing", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const unlink = vi.fn((path: string) => { if (path === alias) throw new Error("EACCES simulated"); });
    const processor = makeCleanupPartProcessor({ unlink });
    await expect(processor.run(job(file), runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("never deletes the alias before an unreachable source unlink failure", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const unlink = vi.fn((path: string) => { if (path === file) throw new Error("EIO simulated"); rmSync(path); });
    const processor = makeCleanupPartProcessor({ unlink });
    await expect(processor.run(job(file), runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("never converts a simulated unlink ENOENT into success without proof", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const unlink = vi.fn(() => {
      const error = new Error("ENOENT simulated") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const processor = makeCleanupPartProcessor({ unlink });
    await expect(processor.run(job(file), runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("repeated direct calls remain rejected without upgrading legacy ctx", async () => {
    const legacyJob = job(put("a_000.ts"));
    const file = legacyJob.inputs[0]!;
    const alias = putAlias(file);
    const before = JSON.stringify(legacyJob);
    await expect(cleanupPartProcessor.run(legacyJob, runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    await expect(cleanupPartProcessor.run(legacyJob, runCtx())).rejects.toThrow(/no qualified per-part observation executor/i);
    expect(JSON.stringify(legacyJob)).toBe(before);
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });

  it("recover holds uncertain before any filesystem access instead of rerunning", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const legacyJob = job(file);
    const before = JSON.stringify(legacyJob);
    const exists = vi.fn(() => true);
    const stat = vi.fn(() => fpOf(file));
    const unlink = vi.fn();
    const processor = makeCleanupPartProcessor({ exists, stat, unlink });
    await expect(processor.recover!(legacyJob, runCtx())).resolves.toBe("uncertain");
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(JSON.stringify(legacyJob)).toBe(before);
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });
  it.each([2, 99])("does not invent a positive executor for ctx version %s", async (version) => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const unsupportedJob = job(file, { ctx: { v: version, orderKey: "same-broadcast", index: 1,
      file, fp: fpOf(file), bv: "DRAFT-1" } });
    const exists = vi.fn(() => true);
    const stat = vi.fn(() => fpOf(file));
    const unlink = vi.fn();
    const processor = makeCleanupPartProcessor({ exists, stat, unlink });
    expect(processor.validate(unsupportedJob)).not.toBeNull();
    await expect(processor.run(unsupportedJob, runCtx())).rejects.toThrow();
    await expect(processor.recover!(unsupportedJob, runCtx())).resolves.toBe("uncertain");
    expect(exists).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf-8")).toBe("x");
    expect(readFileSync(alias, "utf-8")).toBe("x");
  });
});
