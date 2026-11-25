/** issue #752:上传失败分类的护栏用例(顺序敏感 + 三类边界)。 */
import { describe, expect, it } from "vitest";
import { classifyUploadOutcome } from "./upload-outcome.js";
import { JobAbortedError } from "./job-abort.js";

describe("classifyUploadOutcome", () => {
  it("明确无意图、无 BV → 安全重试(没有副作用)", () => {
    const p = classifyUploadOutcome({ intentCommitted: false, error: new Error("error sending request") });
    expect(p.class).toBe("safe-retry");
    expect(p.retryable).toBe(true);
    expect(p.code).toBe("unknown");
  });

  it("**缺 intent 证据**(undefined / 旧数据)→ 不证明未提交 → 只读核验", () => {
    expect(classifyUploadOutcome({}).class).toBe("verify-manual");
    expect(classifyUploadOutcome({ intentCommitted: undefined, bv: null }).code).toBe("intent-unknown");
  });

  it("错误本身带用户停止标记 → 即便调用方没传 userStop 也不重试", () => {
    const err = new JobAbortedError();
    const p = classifyUploadOutcome({ intentCommitted: false, error: err });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("user-stop");
  });

  it("错误本身带 append-ambiguous 标记 → 即便有 BV+逐P确认也不续跑", () => {
    const err = new Error("[append-ambiguous] append 结果不确定(proof=unknown),不重试");
    const p = classifyUploadOutcome({ intentCommitted: true, bv: "BV1abc", partsConfirmed: true, error: err });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("ambiguous");
  });

  it("限流 → 安全重试,但**不消耗重试次数**", () => {
    const err = Object.assign(new Error("upload rate limited"), { code: "rate-limit" });
    const p = classifyUploadOutcome({ intentCommitted: false, error: err });
    expect(p.class).toBe("safe-retry");
    expect(p.countsAsFailure).toBe(false);
  });

  it("凭据过期 → 转人工(修账号),不重试", () => {
    const err = Object.assign(new Error("cookie expired"), { code: "login-expired" });
    const p = classifyUploadOutcome({ error: err });
    expect(p.class).toBe("verify-manual");
    expect(p.retryable).toBe(false);
    expect(p.code).toBe("login-expired");
  });

  it("已建稿 + 逐P确认齐全 → 幂等续跑(只补未提交分P)", () => {
    const p = classifyUploadOutcome({ intentCommitted: true, bv: "BV1abc", partsConfirmed: true, error: new Error("rc=1") });
    expect(p.class).toBe("resume-append");
    expect(p.retryable).toBe(true);
  });

  it("已建稿但逐P证据不完整 → 只读核验,不重传(BV 不是 append 幂等键)", () => {
    const p = classifyUploadOutcome({ intentCommitted: true, bv: "BV1abc", partsConfirmed: false });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("bv-unconfirmed");
  });

  it("意图已落盘但没拿到 BV → 只读核验(重发会造第二个稿)", () => {
    const p = classifyUploadOutcome({ intentCommitted: true });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("intent-unknown");
  });

  it("append-ambiguous 永远不自动重发", () => {
    const p = classifyUploadOutcome({ ambiguous: true, intentCommitted: true, bv: "BV1abc", partsConfirmed: true });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("ambiguous");
  });

  it("用户停止 → 不自动复活(优先级最高)", () => {
    const p = classifyUploadOutcome({ userStop: true, ambiguous: true, intentCommitted: true, bv: "BV1abc" });
    expect(p.class).toBe("verify-manual");
    expect(p.code).toBe("user-stop");
  });
});
