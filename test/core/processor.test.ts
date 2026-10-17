// plans/036 T1:处理器契约 / 注册表 / jobId / 不变量 / 状态机 / 派发编解码。
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("parseJobId 对 generation 超 2^53 返回 null(不丢精度)", () => {
    // 用表达式拼出超安全整数,避免在源码里写裸长数字(隐私检查会把长数字当房间号)
    const over = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(parseJobId(`remux:k#g${over}`)).toBeNull();
    expect(parseJobId(`remux:k#g${over + 1n}`)).toBeNull();
    expect(parseJobId(`remux:k#g${Number.MAX_SAFE_INTEGER}`)?.generation).toBe(Number.MAX_SAFE_INTEGER);
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

  it("根的父目录 `<root>/..` 被拒(rel === \"..\" 分支)", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}/..`], replaceInputs: false }), allowed)).toThrow(/allowedRoots/);
  });

  it("空串 / 相对 allowedRoots 被忽略(fail-closed,不按 cwd 解析)", () => {
    const inCwd = `${process.cwd()}/a_000.ts`;
    expect(() => assertJobInvariants(mkJob({ inputs: [inCwd] }), { allowedRoots: [""] })).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob({ inputs: [inCwd] }), { allowedRoots: ["."] })).toThrow(/allowedRoots/);
    expect(() => assertJobInvariants(mkJob({ inputs: [inCwd] }), { allowedRoots: ["test"] })).toThrow(/allowedRoots/);
    // 空串/相对根混入合法根:合法根照常放行
    expect(() => assertJobInvariants(mkJob(), { allowedRoots: ["", "rel", ROOT] })).not.toThrow();
  });

  it("含 NUL 的路径被拒", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: [`${ROOT}/a\0.ts`] }), allowed)).toThrow(/路径非法/);
    expect(() => assertJobInvariants(mkJob({ outputs: [`${ROOT}/o\0.mkv`] }), allowed)).toThrow(/路径非法/);
  });

  it("replaceInputs 时 outputs 与 inputs 重叠被拒;replaceInputs=false 不查", () => {
    const same = `${ROOT}/x/a_000.ts`;
    expect(() => assertJobInvariants(mkJob({ outputs: [same] }), allowed)).toThrow(/重叠/);
    expect(() => assertJobInvariants(mkJob({ outputs: [`${ROOT}/x/../x/a_000.ts`] }), allowed)).toThrow(/重叠/);
    expect(() => assertJobInvariants(mkJob({ outputs: [same], replaceInputs: false }), allowed)).not.toThrow();
  });

  // 口径钉死:isUnderRoot 是纯字符串判定、不跟符号链接 —— `<root>/link -> 根外` 下的路径在 core 层放行,
  // 由节点侧 realpath 校验兜底(plans/036 T9a,真用例见 test/app/node-enqueue.test.ts「符号链接逃逸」)。
  it("符号链接逃逸:core 纯字符串口径放行 <root>/link -> 根外 下的路径(realpath 校验在节点侧,T9a)", () => {
    const base = mkdtempSync(join(tmpdir(), "core-symlink-"));
    try {
      const inRoot = join(base, "root"); const out = join(base, "out");
      mkdirSync(inRoot); mkdirSync(out);
      symlinkSync(out, join(inRoot, "link"));
      const p = join(inRoot, "link", "a_000.ts");
      expect(() => assertJobInvariants(mkJob({ inputs: [p] }), { allowedRoots: [inRoot] })).not.toThrow();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("任一路径越界即拒:inputs 合法但 outputs 越界", () => {
    expect(() => assertJobInvariants(mkJob({ outputs: ["/tmp/out.mkv"] }), allowed)).toThrow(/allowedRoots/);
  });

  it("多个 allowedRoots:命中任一即可", () => {
    expect(() => assertJobInvariants(mkJob({ inputs: ["/stage/z/a_000.ts"] }), { allowedRoots: [ROOT, "/stage"] })).not.toThrow();
  });

  it("jobId 的 kind / logicalKey 单独不一致也被拒", () => {
    const other = jobIdOf("merge", "task1:a_000.ts@1-2", 1);
    expect(() => assertJobInvariants(mkJob({ jobId: other }), allowed)).toThrow(/不一致/);
    const otherKey = jobIdOf("remux", "other-key", 1);
    expect(() => assertJobInvariants(mkJob({ jobId: otherKey }), allowed)).toThrow(/不一致/);
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

  it("PROC_TRANSITIONS 运行时冻结(含各行数组),无法被篡改", () => {
    expect(Object.isFrozen(PROC_TRANSITIONS)).toBe(true);
    for (const s of ALL) expect(Object.isFrozen(PROC_TRANSITIONS[s]), s).toBe(true);
    expect(() => (PROC_TRANSITIONS.uncertain as unknown as string[]).push("pending")).toThrow();
    expect(canTransition("uncertain", "pending", { reason: "requeue" })).toBe(false);
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

  it("拒 owner 非对象 / owner 字段类型非法 / outputs 非字符串数组", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const withJob = (over: object) => enc({ v: 1, jobs: [{ ...mkJob(), ...over }] });
    expect(() => decodeEnqueue(withJob({ owner: "x" }))).toThrow(/owner/);
    expect(() => decodeEnqueue(withJob({ owner: null }))).toThrow(/owner/);
    expect(() => decodeEnqueue(withJob({ owner: { taskId: "1" } }))).toThrow(/owner\.taskId/);
    expect(() => decodeEnqueue(withJob({ owner: { streamKey: 1 } }))).toThrow(/owner\.streamKey/);
    expect(() => decodeEnqueue(withJob({ outputs: [1] }))).toThrow(/outputs/);
    expect(() => decodeEnqueue(withJob({ outputs: "a.mkv" }))).toThrow(/outputs/);
  });

  it("ordering fields (orderKey/seq/notBefore/prepJobId) survive the wire", () => {
    const j = mkJob({ orderKey: "k", seq: 2, notBefore: 1234, prepJobId: "upload-prep:x#g1" });
    expect(decodeEnqueue(encodeEnqueue({ v: 1, jobs: [j] })).jobs[0]).toEqual(j);
    // null / absent stay absent (old masters never send them)
    const plain = decodeEnqueue(encodeEnqueue({ v: 1, jobs: [mkJob()] })).jobs[0]!;
    expect(plain).not.toHaveProperty("orderKey");
    expect(plain).not.toHaveProperty("seq");
  });

  it("rejects malformed ordering fields", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const withJob = (over: object) => enc({ v: 1, jobs: [{ ...mkJob(), ...over }] });
    expect(() => decodeEnqueue(withJob({ orderKey: "", seq: 1 }))).toThrow(/orderKey/);
    expect(() => decodeEnqueue(withJob({ orderKey: 5, seq: 1 }))).toThrow(/orderKey/);
    expect(() => decodeEnqueue(withJob({ orderKey: "k", seq: 0 }))).toThrow(/seq/);
    expect(() => decodeEnqueue(withJob({ orderKey: "k" }))).toThrow(/需要 seq/);
    expect(() => decodeEnqueue(withJob({ notBefore: "soon" }))).toThrow(/notBefore/);
    expect(() => decodeEnqueue(withJob({ prepJobId: 3 }))).toThrow(/prepJobId/);
  });

  it("拒重复 jobId", () => {
    const j = mkJob();
    expect(() => decodeEnqueue(encodeEnqueue({ v: 1, jobs: [j, j] }))).toThrow(/重复 jobId/);
    expect(decodeEnqueue(encodeEnqueue({ v: 1, jobs: [j, mkJob({ generation: 2 })] })).jobs).toHaveLength(2);
  });

  it("未知字段不透传(白名单重建),owner 只留 taskId/streamKey", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const out = decodeEnqueue(enc({ v: 1, jobs: [{ ...mkJob(), evil: 1, owner: { taskId: 2, streamKey: "k", x: 1 } }] }));
    expect(out.jobs[0]).not.toHaveProperty("evil");
    expect(out.jobs[0]!.owner).toEqual({ taskId: 2, streamKey: "k" });
    expect(out.jobs[0]).not.toHaveProperty("outputs");
  });

  it("拒非法 base64(尾部垃圾 / 非法字符);合法 base64 去填充仍可解", () => {
    const good = encodeEnqueue({ v: 1, jobs: [] });
    expect(() => decodeEnqueue(good + "@@@")).toThrow(/无法解码/);
    expect(() => decodeEnqueue(good.slice(0, 4) + "!" + good.slice(4))).toThrow(/无法解码/);
    expect(decodeEnqueue(good.replace(/=+$/, ""))).toEqual({ v: 1, jobs: [] });
  });

  it("空 jobs 合法", () => {
    expect(decodeEnqueue(encodeEnqueue({ v: 1, jobs: [] }))).toEqual({ v: 1, jobs: [] });
  });
});
