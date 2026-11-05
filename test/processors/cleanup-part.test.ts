// plan 046 PR2: cleanup-part — the only queue processor allowed to delete sources (§5.4 / §8 risk 3).
// Real temp dirs; fs seams (unlink / allowedRoots) inject failures. Contracts only: no caller is wired yet.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  it("kind / lane / flags match plan 046 decisions", () => {
    expect(cleanupPartProcessor.kind).toBe(PART_KINDS.cleanup);
    expect(cleanupPartProcessor.resource).toBe("cpu");
    expect(cleanupPartProcessor.lane).toBe("copy");
    expect(cleanupPartProcessor.retryable).toBe(true);
    expect(cleanupPartProcessor.interruptible).toBe(true);
  });

  it("validate accepts the canonical confirmed-upload ctx job", () => {
    const { j } = okJob();
    expect(cleanupPartProcessor.validate(j)).toBeNull();
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
  it("deletes the source and its upload alias hardlink", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const alert = vi.fn();
    const res = await cleanupPartProcessor.run(job(file), runCtx({ alert }));
    expect(res.note).toContain("deleted");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(alias)).toBe(false);
    expect(alert).not.toHaveBeenCalled(); // the runner alerts rejections once; success must stay quiet
  });

  it("succeeds when no alias exists", async () => {
    const file = put("a_000.ts");
    await cleanupPartProcessor.run(job(file), runCtx());
    expect(existsSync(file)).toBe(false);
  });

  it("a changed file fingerprint keeps BOTH files and never deletes", async () => {
    const j = job(put("a_000.ts"));
    const file = j.inputs[0]!;
    const alias = putAlias(file);
    writeFileSync(file, "content replaced after sealing"); // size drifts: another file wearing the path
    await expect(cleanupPartProcessor.run(j, runCtx())).rejects.toThrow(/指纹不符/);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it("a touched mtime alone also refuses the delete", async () => {
    const j = job(put("a_000.ts"));
    utimesSync(j.inputs[0]!, new Date(1_700_000_000), new Date(1_700_000_000));
    await expect(cleanupPartProcessor.run(j, runCtx())).rejects.toThrow(/指纹不符/);
    expect(existsSync(j.inputs[0]!)).toBe(true);
  });

  it("an already-deleted source is idempotent success", async () => {
    const j = job(put("a_000.ts"));
    rmSync(j.inputs[0]!);
    const res = await cleanupPartProcessor.run(j, runCtx());
    expect(res.note).toMatch(/幂等/);
  });

  it("a lost lease aborts before any unlink", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const p = makeCleanupPartProcessor({ unlink: vi.fn() });
    await expect(p.run(job(file), runCtx({ assertLease: () => { throw new Error("lease lost"); } })))
      .rejects.toThrow(/lease lost/);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it("alias unlink failure keeps the source and throws (never half-silent)", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const p = makeCleanupPartProcessor({
      unlink: (path) => { if (path === alias) throw new Error("EACCES simulated"); },
    });
    await expect(p.run(job(file), runCtx())).rejects.toThrow(/删除别名失败/);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it("source unlink failure throws with the alias already gone and the source kept", async () => {
    const file = put("a_000.ts");
    const alias = putAlias(file);
    const p = makeCleanupPartProcessor({
      unlink: (path) => { if (path === file) throw new Error("EIO simulated"); unlinkSyncSafe(path); },
    });
    await expect(p.run(job(file), runCtx())).rejects.toThrow(/别名已删/);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(alias)).toBe(false);
  });

  it("a source that races away during unlink is still idempotent success", async () => {
    const file = put("a_000.ts");
    const p = makeCleanupPartProcessor({
      unlink: (path) => { if (path !== file) unlinkSyncSafe(path); else { const e = new Error("ENOENT simulated") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } },
    });
    const res = await p.run(job(file), runCtx());
    expect(res.note).toMatch(/幂等/);
  });

  it("running twice after success stays idempotent", async () => {
    const j = job(put("a_000.ts"));
    putAlias(j.inputs[0]!);
    await cleanupPartProcessor.run(j, runCtx());
    const again = await cleanupPartProcessor.run(j, runCtx());
    expect(again.note).toMatch(/幂等/);
  });

  it("recover reruns (existence + fingerprint re-checked every attempt)", async () => {
    await expect(cleanupPartProcessor.recover!(job(put("a_000.ts")), runCtx())).resolves.toBe("rerun");
  });
});

function unlinkSyncSafe(p: string): void { rmSync(p, { force: true }); }
