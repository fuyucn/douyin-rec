import { describe, expect, it } from "vitest";
import { isUploadPendingResult } from "./live-pump-exit.js";

describe("isUploadPendingResult", () => {
  it("accepts the pump's structured uploadPending verdict", () => {
    expect(isUploadPendingResult({ ok: false, uploadPending: true })).toBe(true);
  });

  it("does not infer pending from a human-readable error", () => {
    // A permanent local state ("not resubmitting") must keep its failure path; matching text
    // here was the bug that would have handed it to the automatic retry loop.
    expect(isUploadPendingResult({ ok: false, error: "not resubmitting: spool is missing" })).toBe(false);
    expect(isUploadPendingResult({ ok: false, error: "preupload failed" })).toBe(false);
  });

  it("never treats a successful run as pending", () => {
    expect(isUploadPendingResult({ ok: true, uploadPending: false })).toBe(false);
    expect(isUploadPendingResult({ ok: true })).toBe(false);
  });
});
