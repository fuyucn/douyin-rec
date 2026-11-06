// plan 046 PR1: per-part kinds, ctx contract, workflow templates and state-machine edges.
import { describe, it, expect } from "vitest";
import {
  PART_KINDS, PART_WORKFLOW_TEMPLATES, assertJobInvariants, canTransition, jobIdOf,
  PROC_TRANSITIONS, type JobState, type PartCtx, type ProcessJob, type TransitionReason,
} from "@drec/core";

const ROOT = "/data/recordings";
const FILE = ROOT + "/a_000.ts";
const ctx = (over: Partial<PartCtx> = {}): PartCtx => ({
  v: 1, orderKey: "same-broadcast", index: 1, file: FILE,
  fp: { size: 100, mtimeMs: 1000 }, ...over,
});
const partJob = (kind: string, over: Partial<ProcessJob> = {}): ProcessJob => {
  const logicalKey = over.logicalKey ?? "same-broadcast:part-1";
  const generation = over.generation ?? 1;
  return {
    jobId: jobIdOf(kind, logicalKey, generation), kind, logicalKey, generation,
    inputs: [FILE], params: { ctx: ctx() }, replaceInputs: false,
    owner: { taskId: 1 }, createdAt: 1, ...over,
  };
};
const allowed = { allowedRoots: [ROOT] };

describe("part-chain contract", () => {
  it("exports the three kinds and one immutable workflow template per mode", () => {
    expect(PART_KINDS).toEqual({ upload: "upload-part", cleanup: "cleanup-part", reconcile: "reconcile-part" });
    expect(Object.isFrozen(PART_KINDS)).toBe(true);
    expect(Object.isFrozen(PART_WORKFLOW_TEMPLATES)).toBe(true);
    expect(PART_WORKFLOW_TEMPLATES["live-pump"].uploadAt).toBe("never");
    expect(PART_WORKFLOW_TEMPLATES.rolling.cleanupScope).toBe("part");
    expect(PART_WORKFLOW_TEMPLATES["whole-order"].cleanupScope).toBe("order");
  });

  it("validates persisted ctx; rejects relative paths, subtitles, sidecars and bad fingerprints", () => {
    for (const kind of [PART_KINDS.upload, PART_KINDS.reconcile]) {
      expect(() => assertJobInvariants(partJob(kind), allowed)).not.toThrow();
    }
    expect(() => assertJobInvariants(partJob(PART_KINDS.cleanup, { params: {} }), allowed)).not.toThrow();
    const badCtx: Array<[string, unknown]> = [
      ["missing ctx", undefined], ["wrong version", { ...ctx(), v: 2 }],
      ["empty order", { ...ctx(), orderKey: "" }], ["zero index", { ...ctx(), index: 0 }],
      ["relative file", { ...ctx(), file: "a_000.ts" }],
      ["xml", { ...ctx(), file: ROOT + "/a.xml" }],
      ["ass", { ...ctx(), file: ROOT + "/a.ass" }],
      ["sidecar", { ...ctx(), file: ROOT + "/a.session.json" }],
      ["non-video", { ...ctx(), file: ROOT + "/a.txt" }],
      ["no fingerprint", { ...ctx(), fp: undefined }],
      ["negative size", { ...ctx(), fp: { size: -1, mtimeMs: 1 } }],
      ["invalid bv", { ...ctx(), bv: "" }],
      ["outside root", { ...ctx(), file: "/other/a_000.ts" }],
    ];
    for (const [label, value] of badCtx) {
      const job = partJob(PART_KINDS.upload, { params: value === undefined ? {} : { ctx: value } });
      expect(() => assertJobInvariants(job, allowed), label).toThrow(/params\.ctx|allowedRoots/);
    }
    expect(() => assertJobInvariants(partJob("remux", { params: {} }), allowed)).not.toThrow();
  });

  it("params.sidecarPath must be the canonical sidecar of ctx.file (no caller-chosen path)", () => {
    const okPath = ROOT + "/a_000.rolling.json";
    const withPath = (sidecarPath: unknown): ProcessJob =>
      partJob(PART_KINDS.upload, { params: { ctx: ctx(), sidecarPath } });
    expect(() => assertJobInvariants(withPath(okPath), allowed)).not.toThrow();
    // A caller (a remote _enqueue payload) must not be able to name any other file on the node.
    const bad: Array<[string, unknown]> = [
      ["traversal", ROOT + "/../etc/x.rolling.json"],
      ["other dir", "/other/a_000.rolling.json"],
      ["wrong suffix", ROOT + "/a_000.session.json"],
      ["plain video name", ROOT + "/a_000.ts"],
      ["relative", "a_000.rolling.json"],
      ["empty", ""],
      ["non-string", 42],
    ];
    for (const [label, value] of bad) {
      expect(() => assertJobInvariants(withPath(value), allowed), label).toThrow(/sidecarPath/);
    }
    // sidecarIndex is caller data written into the session ledger: only a non-negative integer passes.
    const withIndex = (sidecarIndex: unknown): ProcessJob =>
      partJob(PART_KINDS.upload, { params: { ctx: ctx(), sidecarIndex } });
    expect(() => assertJobInvariants(withIndex(0), allowed)).not.toThrow();
    expect(() => assertJobInvariants(withIndex(-1), allowed)).toThrow(/sidecarIndex/);
    expect(() => assertJobInvariants(withIndex(1.5), allowed)).toThrow(/sidecarIndex/);
    expect(() => assertJobInvariants(withIndex("0"), allowed)).toThrow(/sidecarIndex/);
    // The path must follow the part file, not the job's inputs.
    const otherFile = ROOT + "/b_001.ts";
    const job = partJob(PART_KINDS.upload, {
      inputs: [otherFile], params: { ctx: ctx({ file: otherFile }), sidecarPath: okPath },
    });
    expect(() => assertJobInvariants(job, allowed)).toThrow(/sidecarPath/);
  });

  it("rejects orderKey/seq on cleanup rows so cleanup can run beside later uploads", () => {
    expect(() => assertJobInvariants(partJob(PART_KINDS.cleanup, { orderKey: "same-broadcast", seq: 1 }), allowed))
      .toThrow(/orderKey\/seq/);
    expect(() => assertJobInvariants(partJob(PART_KINDS.cleanup, { seq: 1 }), allowed))
      .toThrow(/orderKey\/seq/);
    expect(() => assertJobInvariants(partJob(PART_KINDS.upload, { orderKey: "same-broadcast", seq: 1 }), allowed))
      .not.toThrow();
  });

  it("new states are frozen and every transition edge is reason-gated", () => {
    const states: JobState[] = ["pending", "running", "done", "failed", "uncertain", "cancelled", "skipped", "reconciling"];
    expect(Object.keys(PROC_TRANSITIONS).sort()).toEqual([...states].sort());
    for (const state of states) expect(Object.isFrozen(PROC_TRANSITIONS[state]), state).toBe(true);
    expect(PROC_TRANSITIONS.skipped).toEqual([]);
    expect(PROC_TRANSITIONS.reconciling).toEqual(["done", "failed", "pending", "reconciling"]);
    const legal: Array<[JobState, JobState, TransitionReason]> = [
      ["running", "reconciling", "reconcile-start"],
      ["reconciling", "reconciling", "reconcile-unknown"],
      ["reconciling", "done", "reconcile-yes"],
      ["reconciling", "pending", "reconcile-no-resend"],
      ["reconciling", "failed", "reconcile-timeout"],
      ["running", "skipped", "skip-hub-owned"],
      ["running", "skipped", "skip-source-gone"],
    ];
    for (const [from, to, reason] of legal) {
      const ctx = reason === "reconcile-no-resend" ? { reason, allowReconcileResend: true } : { reason };
      expect(canTransition(from, to, ctx), from + "->" + to).toBe(true);
      expect(canTransition(from, to), "ungated " + from + "->" + to).toBe(false);
    }
    expect(canTransition("reconciling", "pending", { reason: "reconcile-no-resend" })).toBe(false);
    for (const to of states) {
      if (!["done", "failed", "pending", "reconciling"].includes(to)) {
        expect(canTransition("reconciling", to, { reason: "reconcile-yes" }), "reconciling->" + to).toBe(false);
      }
      expect(canTransition("skipped", to, { reason: "requeue" }), "skipped->" + to).toBe(false);
    }
    expect(canTransition("running", "skipped", { reason: "requeue" })).toBe(false);
    expect(canTransition("pending", "skipped", { reason: "skip-hub-owned" })).toBe(false);
    expect(canTransition("reconciling", "running", { reason: "reconcile-start" })).toBe(false);
    expect(canTransition("reconciling", "skipped", { reason: "skip-source-gone" })).toBe(false);
    expect(canTransition("reconciling", "uncertain", { reason: "reconcile-timeout" })).toBe(false);
    expect(canTransition("reconciling", "reconciling", { reason: "reconcile-start" })).toBe(false);
  });
});
