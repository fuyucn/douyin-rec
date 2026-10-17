import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadPrepProcessor, produceStageParts } from "../../packages/processors/src/upload-prep.js";

vi.mock("@drec/post-process", async (orig) => ({
  ...(await orig() as object),
  ffprobeDuration: vi.fn(async () => 60),
  remuxSegment: vi.fn(async (src: string, out: string) => { writeFileSync(out, "remuxed"); }),
  mergeSession: vi.fn(async (_files: string[], out: string) => { writeFileSync(out, "merged"); }),
}));

function scene(): { root: string; segs: string[]; stage: string } {
  const root = mkdtempSync(join(tmpdir(), "prep-"));
  const segs = [0, 1].map((i) => { const p = join(root, `s_${i}.ts`); writeFileSync(p, "src"); return p; });
  return { root, segs, stage: join(root, "stage") };
}

describe("upload-prep (plan 038 T04)", () => {
  it("produces stage parts and leaves source inode/content unchanged", async () => {
    const { segs, stage } = scene();
    const before = segs.map((f) => [statSync(f).ino, statSync(f).size]);
    const parts = await produceStageParts({ segments: segs, stageDir: stage, stem: "x", mergeSegments: false, segmentGroupSec: 0, minSegmentSec: 2, tsDirect: false }, () => {});
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => existsSync(p.plain))).toBe(true);
    expect(segs.map((f) => [statSync(f).ino, statSync(f).size])).toEqual(before);
  });

  it("processor: replaceInputs=true is refused; missing stageDir errors; run returns outputs", async () => {
    const { segs, stage } = scene();
    expect(uploadPrepProcessor.validate({ inputs: segs, replaceInputs: true } as never)).toMatch(/must not replace/);
    await expect(uploadPrepProcessor.run({ inputs: segs, params: {}, replaceInputs: false, owner: {}, kind: "upload-prep", logicalKey: "k", generation: 1, jobId: "upload-prep:k#g1" } as never, { log() {}, alert() {}, markProgress() {}, assertLease() {}, signal: new AbortController().signal } as never)).rejects.toThrow(/stageDir/);
    const res = await uploadPrepProcessor.run({ inputs: segs, params: { stageDir: stage, stem: "x", mergeSegments: false }, replaceInputs: false, owner: {}, kind: "upload-prep", logicalKey: "k", generation: 1, jobId: "upload-prep:k#g1" } as never, { log() {}, alert() {}, markProgress() {}, assertLease() {}, signal: new AbortController().signal } as never);
    expect(res.outputs).toHaveLength(2);
  });
});
