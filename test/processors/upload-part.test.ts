// plan 046 §5.4: upload-part — one part, explicit bv/ack + byte/fp proof; no B 站查询、无目录扫描。
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPEND_AMBIGUOUS_MARKER, PART_KINDS, jobIdOf, type ProcessContext, type ProcessJob, type PartCtx,
} from "@drec/core";
import { makeUploadPartProcessor, shouldChainCleanup, PART_WORKFLOW_PARAM, uploadPartProcessor } from "@drec/bilibili-upload";
import type { BiliupHooks } from "../../packages/bilibili-upload/src/run-biliup.js";
import { parseSsAcked } from "../../packages/bilibili-upload/src/biliup-progress.js";

let dir: string;
const setup = (): void => { dir = mkdtempSync(join(tmpdir(), "upload-part-")); };
const teardown = (): void => rmSync(dir, { recursive: true, force: true });
const put = (name = "a_000.ts", body = "abcdefghij"): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
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
const pc = (logs: string[] = [], alerts: string[] = []): ProcessContext => ({
  signal: new AbortController().signal, assertLease: () => {}, markProgress: () => {},
  log: (m: string) => { logs.push(m); }, alert: (m: string) => { alerts.push(m); }, setState: vi.fn(),
});
// Default run seam: a live child pid, the transfer-complete line while the child is still alive (the
// supervisor samples tcp bytes there; a dead child's sockets are gone), then the final output.
const BV = "BV1" + "a".repeat(9); // parseBV expects BV + 10 chars
const ackedRun = () => vi.fn(async (argv: string[], hooks?: BiliupHooks) => {
  hooks?.onSpawn?.(4242);
  hooks?.onLine?.("All files uploaded successfully");
  if (argv[2] === "upload") return "All files uploaded successfully\n" + BV;
  return "All files uploaded successfully\nok";
});

interface Seam {
  run: ReturnType<typeof ackedRun>;
  readAcked: (pid: number) => Map<string, number> | null;
  /** Every pid the watchdog sampled; the boundary read must use the live child pid, never 0. */
  pids?: number[];
}
const seams = (ackedBytes = 20): Seam => {
  const pids: number[] = [];
  return {
    run: ackedRun(),
    pids,
    readAcked: (pid: number) => { pids.push(pid); return new Map([["local>peer", ackedBytes]]); },
  };
};
const processor = (s: Seam, extra: Record<string, unknown> = {}) => makeUploadPartProcessor({
  run: s.run as never, readAcked: s.readAcked, tickMs: 1, now: () => 1_000_000,
  expectedDurationSec: 60, lookup: { run: async () => "[]", trustNo: true }, probe: () => null,
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
      expect(s.pids!.length).toBeGreaterThan(0);
      expect(s.pids!.every((pid) => pid > 0)).toBe(true);
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
      // A caller-supplied sidecar path is validated against the canonical one (path traversal guard).
      expect(p.validate(job(f, { params: { sidecarPath: join(dir, "a_000.rolling.json") } }))).toBeNull();
      expect(p.validate(job(f, { params: { sidecarPath: "/etc/passwd" } }))).toMatch(/sidecarPath/);
      expect(p.validate(job(f, { params: { sidecarPath: join(dir, "..", "x.rolling.json") } }))).toMatch(/sidecarPath/);
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

  it("a readable boundary sample below the file size is NOT success (truncated transfer)", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      await expect(processor(seams(99)).run(job(f), pc())).rejects.toThrow(/acked bytes 99 < file size 100/);
    } finally { teardown(); }
  });

  it("no usable sample (null / empty listing / all-zero listing) is unknown: confirm + log, never fail", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      const listings: Array<[string, (pid: number) => Map<string, number> | null]> = [
        ["ss unavailable (null)", () => null],
        ["ss listed nothing for the pid", () => new Map()],
        ["all acked numbers are 0", () => new Map([["local>peer", 0]])],
      ];
      for (const [label, readAcked] of listings) {
        const logs: string[] = [];
        const r = await processor({ run: ackedRun(), readAcked }).run(job(f), pc(logs));
        expect(r.confirmed, label).toMatchObject({ ackedBytes: null, size: 100 });
        expect(logs.join(" "), label).toMatch(/byte check unavailable/);
      }
      // Nothing is deleted or refused: a confirmed part still flows to the cleanup chain.
      expect(existsSync(f)).toBe(true);
    } finally { teardown(); }
  });

  it("a boundary listing whose sockets carry no bytes_acked token is unknown, not 0 bytes (ss fixture)", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      const fixture = [
        'ESTAB 0      0         local:53844 peer-a:443   users:(("biliup",pid=4242,fd=9))',
        "\t cubic bytes_sent:904 segs_out:3",
      ].join("\n");
      const logs: string[] = [];
      const r = await processor({ run: ackedRun(), readAcked: () => parseSsAcked(fixture, 4242) }).run(job(f), pc(logs));
      expect(r.confirmed).toMatchObject({ ackedBytes: null });
      expect(logs.join(" ")).toMatch(/byte check unavailable/);
    } finally { teardown(); }
  });

  it("a socket that closed before the boundary never fails a legitimately confirmed part", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      let phase: "early" | "late" = "early";
      let reads = 0;
      const readAcked = (pid: number) => {
        reads += 1;
        // b disappears before the boundary read: the remaining total (70) is a lower bound, not a count.
        return phase === "early" ? new Map([["a", 40], ["b", 60]]) : new Map([["a", 70]]);
      };
      const run = vi.fn(async (argv: string[], hooks?: BiliupHooks) => {
        hooks?.onSpawn?.(4242);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        phase = "late";
        hooks?.onLine?.("All files uploaded successfully");
        return argv[2] === "upload" ? "All files uploaded successfully\n" + BV : "All files uploaded successfully\nok";
      });
      const logs: string[] = [];
      const r = await processor({ run, readAcked }).run(job(f), pc(logs));
      expect(r.confirmed).toMatchObject({ ackedBytes: null });
      expect(logs.join(" ")).toMatch(/byte check unavailable/);
    } finally { teardown(); }
  });

  it("the boundary reading uses the live child pid while the run is still unresolved (pid=0 root cause)", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      let resolved = false;
      const reads: Array<{ pid: number; alive: boolean }> = [];
      const readAcked = (pid: number) => {
        reads.push({ pid, alive: !resolved });
        // The pid=0 root cause: an unusable pid could only ever read an empty listing.
        return pid > 0 ? new Map([["local>peer", 200]]) : new Map();
      };
      const run = vi.fn(async (argv: string[], hooks?: BiliupHooks) => {
        hooks?.onSpawn?.(4242);
        hooks?.onLine?.("All files uploaded successfully");
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
        return argv[2] === "upload" ? "All files uploaded successfully\n" + BV : "All files uploaded successfully\nok";
      });
      const r = await processor({ run, readAcked }).run(job(f), pc());
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((x) => x.pid > 0)).toBe(true);
      expect(reads.some((x) => x.alive)).toBe(true);
      expect(r.confirmed).toMatchObject({ ackedBytes: 200 });
    } finally { teardown(); }
  });

  it("mid-transfer samples alone never judge the part (the live boundary snapshot is the proof)", async () => {
    setup();
    try {
      const f = put("a_000.ts", "x".repeat(100));
      // Samples arrive while transferring but the boundary line never reaches the hooks: the last
      // sample is by definition short of the final acked bytes, so it must not fail the part.
      let reads = 0;
      const readAcked = () => { reads += 1; return new Map([["local>peer", 40]]); };
      const run = vi.fn(async (argv: string[], hooks?: BiliupHooks) => {
        hooks?.onSpawn?.(4242);
        hooks?.onLine?.("uploading chunk 1/2");
        // Wait for at least one real mid-transfer sample before finishing the transfer.
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        return argv[2] === "upload" ? "All files uploaded successfully\n" + BV : "All files uploaded successfully\nok";
      });
      const logs: string[] = [];
      const r = await processor({ run, readAcked }).run(job(f), pc(logs));
      expect(r.confirmed).toMatchObject({ ackedBytes: null });
      expect(logs.join(" ")).toMatch(/byte check unavailable/);
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

  it("P2: create associates the season with the same helper/checkpoints", async () => {
    setup();
    try {
      const f = put();
      const addSeason = vi.fn(async () => ({ status: "added" as const, sectionId: 9, aid: 1, cid: 2, title: "t" }));
      const c = pc();
      const p = makeUploadPartProcessor({ run: seams().run as never, readAcked: seams().readAcked, addSeason: addSeason as never });
      await p.run(job(f, { params: { seasonSectionId: 9 } }), c);
      expect(addSeason).toHaveBeenCalledTimes(1);
      expect(addSeason.mock.calls[0]![0]).toMatchObject({ sectionId: 9, bvid: BV });
      const setState = (c as unknown as { setState: ReturnType<typeof vi.fn> }).setState;
      expect(setState).toHaveBeenCalledWith({ bv: BV, seasonState: "pending" });
      expect(setState).toHaveBeenCalledWith({ seasonState: "done" });
    } finally { teardown(); }
  });

  it("B3: the confirmed part is written back to the canonical sidecar next to the part file", async () => {
    setup();
    try {
      const f = put("主播_2026-06-27_08-00-00_000.ts");
      const sidecar = join(dir, "主播_2026-06-27_08-00-00.rolling.json");
      writeFileSync(sidecar, JSON.stringify({ streamKey: "k", sessionBase: "b", segments: [{ index: 0, path: f }], confirmed: [], updatedAt: 1 }));
      const p = makeUploadPartProcessor({ run: seams().run as never, readAcked: seams().readAcked });
      // The job names the canonical path; the processor derives the same one from ctx.file.
      await p.run(job(f, { params: { sidecarPath: sidecar, sidecarIndex: 0, queueOrderKey: "k" } }), pc());
      const st = JSON.parse(readFileSync(sidecar, "utf-8")) as { bv?: string; confirmed?: number[]; queueOrderKey?: string };
      expect(st.bv).toBe(BV);
      expect(st.confirmed).toEqual([0]);
      expect(st.queueOrderKey).toBe("k");
    } finally { teardown(); }
  });

  it("B3b: a sidecar path that is a symlink to an outside file is never followed", async () => {
    setup();
    try {
      const f = put();
      const outside = join(dir, "..", "outside-" + String(Date.now()) + ".json");
      writeFileSync(outside, JSON.stringify({ keep: true }));
      const sidecar = join(dir, "a_000.rolling.json");
      // The canonical path itself is a symlink: writeFileAtomicSync renames over the link, so the
      // target outside the part directory keeps its bytes.
      try { symlinkSync(outside, sidecar); }
      catch { rmSync(outside, { force: true }); return; } // symlinks unavailable (permissions): skip
      const p = makeUploadPartProcessor({ run: seams().run as never, readAcked: seams().readAcked });
      await p.run(job(f, { params: { sidecarIndex: 0, queueOrderKey: "k" } }), pc());
      expect(JSON.parse(readFileSync(outside, "utf-8"))).toEqual({ keep: true });
      expect(JSON.parse(readFileSync(sidecar, "utf-8"))).toMatchObject({ bv: BV });
      rmSync(outside, { force: true });
    } finally { teardown(); }
  });

  it("B3c: a missing rolling sidecar is alerted (master may re-upload), never created", async () => {
    setup();
    try {
      const f = put();
      const alerts: string[] = [];
      const c = { ...pc(), alert: (m: string) => { alerts.push(m); } };
      const p = makeUploadPartProcessor({ run: seams().run as never, readAcked: seams().readAcked });
      // The producer declared a sidecar path (the queue always does); the file never appeared.
      await p.run(job(f, { params: { sidecarIndex: 0, sidecarPath: join(dir, "a_000.rolling.json") } }), c as never);
      expect(existsSync(join(dir, "a_000.rolling.json"))).toBe(false);
      expect(alerts.join(" ")).toMatch(/sidecar is missing/);
    } finally { teardown(); }
  });


  it("B3d: a bogus sidecarIndex is refused by validate and never written by run", async () => {
    setup();
    try {
      const f = put("主播_2026-06-27_08-00-00_000.ts");
      const sidecar = join(dir, "主播_2026-06-27_08-00-00.rolling.json");
      writeFileSync(sidecar, JSON.stringify({ streamKey: "k", sessionBase: "b", segments: [], confirmed: [], updatedAt: 1 }));
      const s = seams();
      const p = makeUploadPartProcessor({ run: s.run as never, readAcked: s.readAcked });
      expect(p.validate(job(f, { params: { sidecarPath: sidecar, sidecarIndex: -1 } }))).toMatch(/sidecarIndex/);
      await p.run(job(f, { params: { sidecarIndex: -1 } }), pc()); // run guards it too
      const st = JSON.parse(readFileSync(sidecar, "utf-8")) as { confirmed?: number[]; bv?: string };
      expect(st.confirmed).toEqual([]);
      expect(st.bv).toBe(BV);
    } finally { teardown(); }
  });
});
