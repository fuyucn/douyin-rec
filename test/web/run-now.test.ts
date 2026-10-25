import { describe, expect, it } from "vitest";
import { nextSubmissionNo, runNowKey, shouldToastRunError, submissionBaseKey } from "../../packages/web/src/lib/run-now.js";

const BASE = "douyin:123:2026-10-24";

describe("submissionBaseKey", () => {
  it("strips a submission suffix from a date key", () => {
    expect(submissionBaseKey(`${BASE}-1`)).toBe(BASE);
    expect(submissionBaseKey(`${BASE}-12`)).toBe(BASE);
  });

  it("does not mistake the trailing day in a date for a submission suffix", () => {
    expect(submissionBaseKey(BASE)).toBe(BASE);
    expect(submissionBaseKey("douyin:123:2026-10-24_0130")).toBe("douyin:123:2026-10-24_0130");
  });

  it("keeps a broadcast-time suffix and strips only the submission suffix", () => {
    expect(submissionBaseKey(`${BASE}_0130-2`)).toBe(`${BASE}_0130`);
  });
});

describe("nextSubmissionNo", () => {
  it("starts at 1", () => {
    expect(nextSubmissionNo(BASE, [])).toBe(1);
  });

  it("uses the highest existing suffix, not the count", () => {
    expect(nextSubmissionNo(BASE, [`${BASE}-1`, `${BASE}-7`, `${BASE}-3`])).toBe(8);
  });

  it("ignores other rooms, other dates, and the bare base key", () => {
    expect(nextSubmissionNo(BASE, [
      BASE,
      "douyin:999:2026-10-24-9",
      "douyin:123:2026-10-23-4",
    ])).toBe(1);
  });
});

describe("runNowKey", () => {
  it("resume keeps the selected key", () => {
    expect(runNowKey({ selectedKey: `${BASE}-3`, existingKeys: [`${BASE}-3`], newSubmission: false }))
      .toBe(`${BASE}-3`);
  });

  it("new submission derives from the base even when the selected row is already -N", () => {
    expect(runNowKey({
      selectedKey: `${BASE}-3`,
      existingKeys: [`${BASE}-1`, `${BASE}-3`, `${BASE}-4`],
      newSubmission: true,
    })).toBe(`${BASE}-5`);
  });
});

describe("shouldToastRunError", () => {
  it("suppresses a forceable 409 until the user confirms force", () => {
    expect(shouldToastRunError({ forceable: true, force: false })).toBe(false);
  });

  it("still reports non-forceable failures and failed force retries", () => {
    expect(shouldToastRunError({ forceable: false, force: false })).toBe(true);
    expect(shouldToastRunError({ forceable: false, force: true })).toBe(true);
    expect(shouldToastRunError({ forceable: true, force: true })).toBe(true);
  });
});
