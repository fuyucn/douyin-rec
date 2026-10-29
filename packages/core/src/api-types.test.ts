/**
 * api-types.test.ts —— 节点侧落盘结果文件 phase 白名单的**唯一真理**归一逻辑(issue #2 A1)。
 *
 * 为什么单独钉:phase 判定曾在两处各写一份(app readNodeResult + ssh transport nodeResult),
 * 新增 started 时漏改一处就被「当 null 吞掉」→ 回读失效。现两处共用本函数,故把
 * 「合法 phase / 非法 phase / 向后兼容 / 字段裁剪」一次性钉死,杜绝将来再次漂移。
 */
import { describe, it, expect } from "vitest";
import { NODE_RESULT_PHASES, NODE_UPLOAD_STEPS, normalizeNodeResultFile } from "./api-types.js";

describe("normalizeNodeResultFile(issue #2 phase 白名单唯一真理)", () => {
  it("NODE_RESULT_PHASES 含 started/uploading/done/failed(issue #2 新增 started)", () => {
    expect([...NODE_RESULT_PHASES].sort()).toEqual(["done", "failed", "started", "uploading"]);
  });

  it("phase=started 被接受(不再被当 null 吞掉)→ 回读能区分「已接管未建稿」", () => {
    const r = normalizeNodeResultFile({ phase: "started", ok: false, atMs: 12 });
    expect(r).toEqual({ phase: "started", ok: false, bv: undefined, products: undefined, error: undefined, atMs: 12 });
  });

  it("四个合法 phase 都能往返;非法 / 缺 phase → null(绝不当成权威结果)", () => {
    for (const phase of ["started", "uploading", "done", "failed"] as const) {
      expect(normalizeNodeResultFile({ phase, ok: true, atMs: 1 })?.phase).toBe(phase);
    }
    expect(normalizeNodeResultFile({ phase: "weird", ok: true })).toBeNull();
    expect(normalizeNodeResultFile({ ok: true })).toBeNull(); // 缺 phase
  });

  it("向后兼容:老结果文件(无新字段、仅 ok/products)仍解析(裁剪而非丢弃)", () => {
    const r = normalizeNodeResultFile({ phase: "done", ok: true, bv: "BV1X", products: ["/a.mp4"] });
    expect(r?.bv).toBe("BV1X");
    expect(r?.products).toEqual(["/a.mp4"]);
    expect(r?.atMs).toBe(0); // 缺省 0,不报错
  });

  it("非对象 / null / 字段类型错误 → 安全归一(null 或裁剪到 undefined)", () => {
    expect(normalizeNodeResultFile(null)).toBeNull();
    expect(normalizeNodeResultFile("string")).toBeNull();
    expect(normalizeNodeResultFile(42)).toBeNull();
    const r = normalizeNodeResultFile({ phase: "failed", ok: false, bv: 123, products: "x", error: null });
    expect(r).toEqual({ phase: "failed", ok: false, bv: undefined, products: undefined, error: undefined, atMs: 0 });
  });
});

describe("normalizeNodeResultFile 的可选 step(plan 038,issue #204)", () => {
  it("phase 词表不变(新增 phase 会被旧 master 归一成 null → 误判确认没成),step 只是附加字段", () => {
    expect([...NODE_RESULT_PHASES].sort()).toEqual(["done", "failed", "started", "uploading"]);
    expect([...NODE_UPLOAD_STEPS]).toEqual(["remux", "gate_wait", "transfer", "submit"]);
  });
  it("四个合法 step 都能往返", () => {
    for (const step of NODE_UPLOAD_STEPS) {
      expect(normalizeNodeResultFile({ phase: "uploading", ok: false, step, atMs: 1 })?.step).toBe(step);
    }
  });
  it("旧 bundle 的结果文件(无 step)照常解析,step 缺省为 undefined", () => {
    const r = normalizeNodeResultFile({ phase: "uploading", ok: false, bv: "BV1x", atMs: 5 });
    expect(r?.phase).toBe("uploading");
    expect(r?.step).toBeUndefined();
  });
  it("非法 step 被丢弃,但不影响 phase 的判定(不会让整份结果变 null)", () => {
    const r = normalizeNodeResultFile({ phase: "uploading", ok: false, step: "weird", atMs: 1 });
    expect(r?.phase).toBe("uploading");
    expect(r?.step).toBeUndefined();
  });

  it("seasonState is optional and invalid values are dropped without invalidating the result", () => {
    for (const seasonState of ["pending", "done", "failed"] as const) {
      expect(normalizeNodeResultFile({ phase: "uploading", ok: false, seasonState, atMs: 1 })?.seasonState).toBe(seasonState);
    }
    const r = normalizeNodeResultFile({ phase: "uploading", ok: false, seasonState: "weird", atMs: 1 });
    expect(r?.phase).toBe("uploading");
    expect(r?.seasonState).toBeUndefined();
  });
});
