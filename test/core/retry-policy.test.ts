// plans/046 PR4: failure classification and backoff are pure processor-contract rules.
import { describe, it, expect } from "vitest";
import {
  classifyRetryableFailure, MAX_BACKOFF_MS, RETRY_BACKOFF_MS, STUCK_ALERT_MS, retryBackoffMs,
  type RetryFailureCode,
} from "@drec/core";

const coded = (code: RetryFailureCode): Error & { code: RetryFailureCode } => Object.assign(new Error(code), { code });

describe("classifyRetryableFailure", () => {
  it("classifies transient, deterministic and rate-limit failures from an enumerable matrix", () => {
    expect(classifyRetryableFailure(new Error("temporary ssh timeout"))).toEqual({ kind: "transient", code: "unknown", retry: true });
    for (const code of ["login-expired", "credentials-invalid", "forbidden", "not-found"] as const) {
      expect(classifyRetryableFailure(coded(code))).toEqual({ kind: "deterministic", code, retry: false });
    }
    expect(classifyRetryableFailure(new Error("code: 21566 投稿过于频繁"))).toEqual({ kind: "rate-limit", code: "rate-limit", retry: false });
    expect(classifyRetryableFailure(new Error("上传视频过快"))).toEqual({ kind: "rate-limit", code: "rate-limit", retry: false });
  });

  it("recognizes known deterministic message shapes without guessing unrelated errors", () => {
    expect(classifyRetryableFailure(new Error("cookie-expired")).code).toBe("credentials-invalid");
    expect(classifyRetryableFailure(new Error("permission-denied")).code).toBe("forbidden");
    expect(classifyRetryableFailure(new Error("missing-cookies")).code).toBe("not-found");
    expect(classifyRetryableFailure(new Error("permission pending"))).toEqual({ kind: "transient", code: "unknown", retry: true });
  });
});

describe("retryBackoffMs", () => {
  it("starts at five minutes, doubles and caps at one hour", () => {
    expect(retryBackoffMs(1)).toBe(RETRY_BACKOFF_MS);
    expect(retryBackoffMs(2)).toBe(RETRY_BACKOFF_MS * 2);
    expect(retryBackoffMs(4)).toBe(RETRY_BACKOFF_MS * 8);
    expect(retryBackoffMs(5)).toBe(MAX_BACKOFF_MS);
    expect(retryBackoffMs(500)).toBe(MAX_BACKOFF_MS);
    expect(STUCK_ALERT_MS).toBe(6 * 60 * 60_000);
  });
});
