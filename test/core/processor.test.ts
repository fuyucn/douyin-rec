// plans/036 T1:处理器契约 / 注册表 / jobId / 不变量 / 状态机 / 派发编解码。
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerProcessor, getProcessor, listProcessors, _resetProcessors,
  jobIdOf, parseJobId, assertJobInvariants,
  PROC_TRANSITIONS, canTransition, cancelOutcome,
  encodeEnqueue, decodeEnqueue,
  type Processor, type ProcessJob, type JobState,
} from "@drec/core";

const fake = (kind: string): Processor => ({
  kind, resource: "cpu", retryable: true, interruptible: true,
  validate: () => null, estimateDiskBytes: () => 0,
  run: async () => ({ outputs: [] }),
});

const ROOT = "/data/recordings";
const mkJob = (over: Partial<ProcessJob> = {}): ProcessJob => {
  const logicalKey = over.logicalKey ?? "task1:a_000.ts@1-2";
  const generation = over.generation ?? 1;
  const kind = over.kind ?? "remux";
  return {
    jobId: jobIdOf(kind, logicalKey, generation), kind, logicalKey, generation,
    inputs: [`${ROOT}/x/a_000.ts`], params: {}, replaceInputs: true, owner: { taskId: 1 }, createdAt: 1,
    ...over,
  };
};
const allowed = { allowedRoots: [ROOT] };

describe("处理器注册表", () => {
  beforeEach(() => _resetProcessors());

  it("注册后按 kind 取回;list 反映已注册项;未知 kind → undefined", () => {
    registerProcessor(fake("remux"));
    registerProcessor(fake("merge"));
    expect(getProcessor("remux")?.kind).toBe("remux");
    expect(listProcessors().map((p) => p.kind).sort()).toEqual(["merge", "remux"]);
    expect(getProcessor("nope")).toBeUndefined();
  });

  it("重复注册同 kind 抛错,且不覆盖原实现", () => {
    const first = fake("remux");
    registerProcessor(first);
    expect(() => registerProcessor(fake("remux"))).toThrow(/已注册/);
    expect(getProcessor("remux")).toBe(first);
  });

  it("_resetProcessors 清空", () => {
    registerProcessor(fake("remux"));
    _resetProcessors();
    expect(listProcessors()).toEqual([]);
  });
});

describe("jobIdOf / parseJobId", () => {
  it("往返:logicalKey 含 ':' / '#' / '#g' 仍可还原", () => {
    for (const key of ["task1:a_000.ts@1-2", "final:douyin:123:2026-01-01:plain:x.mp4@9-9", "k#g7x", "a#b"]) {
      const id = jobIdOf("remux", key, 3);
      expect(id).toBe(`remux:${key}#g3`);
      expect(parseJobId(id)).toEqual({ kind: "remux", logicalKey: key, generation: 3 });
    }
  });

  it("jobIdOf 拒非法入参", () => {
    expect(() => jobIdOf("Re:mux", "k", 1)).toThrow();
    expect(() => jobIdOf("", "k", 1)).toThrow();
    expect(() => jobIdOf("remux", "", 1)).toThrow();
    expect(() => jobIdOf("remux", "k", 0)).toThrow();
    expect(() => jobIdOf("remux", "k", 1.5)).toThrow();
  });

  it("parseJobId 对畸形 id 返回 null", () => {
    for (const bad of ["", "remux", "remux:k", "remux:#g1", "remux:k#g0", "remux:k#gx", ":k#g1", "remux:k#g01"]) {
      expect(parseJobId(bad), bad).toBeNull();
    }
  });
});

describe("assertJobInvariants", () => {
  it("合法 job 通过", () => {
    expect(() => assertJobInvariants(mkJob(), allowed)).not.toThrow();
    expect(() => assertJobInvariants(mkJob({ outputs: [`${ROOT}/x/a.mkv`] }), allowed)).not.toThrow();
  });

  it("空 inputs / 相对路径被拒", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: [] }), allowed)).toThrow(/inputs 为空/);
    expect(() => assertJobInvariants(mkJob({ inputs: ["x/a_000.ts"] }), allowed)).toThrow(/绝对路径/);
    expect(() => assertJobInvariants(mkJob({ outputs: ["rel.mkv"] }), allowed)).toThrow(/绝对路径/);
  });

  it("replaceInputs 含 xml / ass / 会话边车被拒;replaceInputs=false 时不查扩展名", () => {
    for (const f of ["a.xml", "a.ass", "a.session.json", "a_000.ts.drec-remux"]) {
      expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}/x/${f}`] }), allowed), f).toThrow(/replaceInputs/);
    }
    expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}/x/a.xml`], replaceInputs: false }), allowed)).not.toThrow();
  });

  it("路径不在 allowedRoots 下被拒(含 .. 穿越、前缀同名目录、根本身、空 roots)", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: ["/etc/a.ts"] }), allowed)).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}/../secret/a.ts`] }), allowed)).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}-evil/a.ts`] }), allowed)).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob({ inputs: [ROOT], replaceInputs: false }), allowed)).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob(), { allowedRoots: [] })).toThrow(/allowedRoots/);
  });

  it("任一路径越界即拒:inputs 合法但 outputs 越界", () => {
    expect(() => assertJobInvariants(mkJob({ outputs: ["/tmp/out.mkv"] }), allowed)).toThrow(/allowedRoots/);
  });

  it("多个 allowedRoots:命中任一即可", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: ["/stage/z/a_000.ts"] }), { allowedRoots: [ROOT, "/stage"] })).not.toThrow();
  });

  it("jobId 与字段不一致 / 格式非法被拒", () => {
    expect(() => assertJobInvariants(mkJob({ generation: 2, jobId: jobIdOf("remux", "task1:a_000.ts@1-2", 1) }), allowed)).toThrow(/不一致/);
    expect(() => assertJobInvariants(mkJob({ jobId: "garbage" }), allowed)).toThrow(/jobId/);
  });
});

describe("状态机", () => {
  const ALL: JobState[] = ["pending", "running", "done", "failed", "uncertain", "cancelled"];

  it("uncertain → pending 不允许(须先 ack 到 failed 再 requeue)", () => {
    expect(PROC_TRANSITIONS.uncertain).not.toContain("pending");
    expect(canTransition("uncertain", "pending", { reason: "requeue" })).toBe(false);
    expect(canTransition("uncertain", "failed")).toBe(false);
    expect(canTransition("uncertain", "failed", { reason: "ack-uncertain" })).toBe(true);
  });

  it("done / cancelled 终态:任何迁移都不允许", () => {
    for (const from of ["done", "cancelled"] as const) {
      for (const to of ALL) expect(canTransition(from, to, { reason: "requeue", neverClaimed: true }), `${from}→${to}`).toBe(false);
    }
  });

  it("pending → cancelled 仅当从未被认领", () => {
    expect(canTransition("pending", "cancelled")).toBe(false);
    expect(canTransition("pending", "cancelled", { neverClaimed: false })).toBe(false);
    expect(canTransition("pending", "cancelled", { neverClaimed: true })).toBe(true);
  });

  it("running → pending 仅租约过期重跑,或关停时 interruptible", () => {
    expect(canTransition("running", "pending")).toBe(false);
    expect(canTransition("running", "pending", { reason: "lease-expired-rerun" })).toBe(true);
    expect(canTransition("running", "pending", { reason: "shutdown-abort", interruptible: true })).toBe(true);
    expect(canTransition("running", "pending", { reason: "shutdown-abort", interruptible: false })).toBe(false);
    expect(canTransition("running", "pending", { reason: "shutdown-abort" })).toBe(false);
  });

  it("failed → pending 只经 requeue", () => {
    expect(canTransition("failed", "pending")).toBe(false);
    expect(canTransition("failed", "pending", { reason: "requeue" })).toBe(true);
  });

  it("正常主线:pending → running → done|failed|uncertain|cancelled", () => {
    expect(canTransition("pending", "running")).toBe(true);
    for (const to of ["done", "failed", "uncertain", "cancelled"] as const) expect(canTransition("running", to)).toBe(true);
    expect(canTransition("pending", "done")).toBe(false);
  });

  it("cancelOutcome:biliup 写 intent 后取消 → uncertain,其余 cancelled", () => {
    expect(cancelOutcome("biliup", true)).toBe("uncertain");
    expect(cancelOutcome("biliup", false)).toBe("cancelled");
    expect(cancelOutcome("remux", true)).toBe("cancelled");
  });
});

describe("EnqueueRequest 编解码", () => {
  it("往返", () => {
    const req = { v: 1 as const, jobs: [mkJob({ outputs: [`${ROOT}/o.mkv`] })] };
    expect(decodeEnqueue(encodeEnqueue(req))).toEqual(req);
  });

  it("拒 v≠1 / 缺 v", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    expect(() => decodeEnqueue(enc({ v: 2, jobs: [] }))).toThrow(/版本/);
    expect(() => decodeEnqueue(enc({ jobs: [] }))).toThrow(/版本/);
  });

  it("拒非 JSON / 非对象 / jobs 非数组 / job 结构非法", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    expect(() => decodeEnqueue("!!!not-json")).toThrow();
    expect(() => decodeEnqueue(enc([]))).toThrow(/不是对象/);
    expect(() => decodeEnqueue(enc({ v: 1, jobs: "x" }))).toThrow(/jobs/);
    expect(() => decodeEnqueue(enc({ v: 1, jobs: [{ ...mkJob(), generation: 0 }] }))).toThrow(/generation/);
    expect(() => decodeEnqueue(enc({ v: 1, jobs: [{ ...mkJob(), inputs: [1] }] }))).toThrow(/inputs/);
    expect(() => decodeEnqueue(enc({ v: 1, jobs: [{ ...mkJob(), replaceInputs: "yes" }] }))).toThrow(/replaceInputs/);
  });

  it("空 jobs 合法", () => {
    expect(decodeEnqueue(encodeEnqueue({ v: 1, jobs: [] }))).toEqual({ v: 1, jobs: [] });
  });
});
