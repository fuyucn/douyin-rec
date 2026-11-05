// plan 046 PR3: reconcile-part is read-only by default and emits structured measurement logs.
import { describe, it, expect, vi } from "vitest";
import { PART_KINDS, jobIdOf, type ProcessContext, type ProcessJob } from "@drec/core";
import {
  makeReconcilePartProcessor, RECONCILE_DELAY_LOG, RECONCILE_LANE, RECONCILE_SHADOW_LOG,
  type ReconcileDelayRecord, type ReconcileShadowRecord,
} from "../../packages/processors/src/reconcile-part.js";

const FILE = "/data/recordings/a_000.ts";
const job = (over: Partial<ProcessJob> = {}): ProcessJob => ({
  jobId: jobIdOf(PART_KINDS.reconcile, "same-broadcast:part-1", 1), kind: PART_KINDS.reconcile,
  logicalKey: "same-broadcast:part-1", generation: 1, inputs: [FILE],
  params: {
    ctx: { v: 1, orderKey: "same-broadcast", index: 1, file: FILE, fp: { size: 1, mtimeMs: 1 }, bv: "DRAFT" },
    title: "测试标题", expectedDurationSec: 3600, confirmedAt: 1000,
  },
  replaceInputs: false, owner: { taskId: 1 }, createdAt: 1000, ...over,
});
const ctx = () => ({ signal: new AbortController().signal, assertLease() {}, markProgress() {}, log: vi.fn(), alert: vi.fn() } as unknown as ProcessContext);
const records = (lines: string[], tag: string): unknown[] => lines.filter((l) => l.startsWith(tag + " ")).map((l) => JSON.parse(l.slice(tag.length + 1)));

describe("reconcile-part processor", () => {
  it("uses net resource and its own lane, is retryable/interruptible", () => {
    const p = makeReconcilePartProcessor();
    expect(p).toMatchObject({ kind: PART_KINDS.reconcile, resource: "net", lane: RECONCILE_LANE, retryable: true, interruptible: true });
    expect(p.validate(job())).toBeNull();
  });

  it("shadow mode logs would-be outcomes without calling the settle write seam", async () => {
    const log = vi.fn();
    const settle = vi.fn(() => true);
    const p = makeReconcilePartProcessor({
      log, settle, now: () => 2000, findArchive: async () => "yes", listArchives: async () => [{ bv: "DRAFT", title: "测试标题" }],
    });
    expect(await p.run(job(), ctx())).toEqual({ outputs: [] });
    expect(settle).not.toHaveBeenCalled();
    const shadow = records(log.mock.calls.map((c) => String(c[0])), RECONCILE_SHADOW_LOG) as ReconcileShadowRecord[];
    expect(shadow[0]).toMatchObject({ v: 1, kind: "shadow", outcome: "yes", wouldBe: "done", shadowMode: true, at: 2000 });
  });

  it("records the archive-appearance delay as a structured data point", async () => {
    const log = vi.fn();
    const p = makeReconcilePartProcessor({
      log, now: () => 5000, findArchive: async () => "yes", listArchives: async () => [{ bv: "DRAFT", title: "测试标题" }],
    });
    await p.run(job(), ctx());
    const delay = records(log.mock.calls.map((c) => String(c[0])), RECONCILE_DELAY_LOG) as ReconcileDelayRecord[];
    expect(delay[0]).toMatchObject({ v: 1, kind: "archive-delay", confirmedAt: 1000, appearedAt: 5000, delayMs: 4000 });
  });

  it("no is not enabled by default; explicit false shadow mode writes via the injected seam", async () => {
    const log = vi.fn();
    const settle = vi.fn(() => true);
    const deps = { log, settle, now: () => 2000, findArchive: async () => "no" as const, listArchives: async () => [] };
    await makeReconcilePartProcessor(deps).run(job(), ctx());
    expect(settle).not.toHaveBeenCalled();
    expect(records(log.mock.calls.map((c) => String(c[0])), RECONCILE_SHADOW_LOG)[0]).toMatchObject({ outcome: "no(未启用)", wouldBe: "reconciling" });
    await makeReconcilePartProcessor({ ...deps, shadowMode: false }).run(job(), ctx());
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

