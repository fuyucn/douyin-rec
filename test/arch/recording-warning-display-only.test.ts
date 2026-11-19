import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

// Issue #351: recordingWarningLimit is display-only. It may live in the worker contract, the
// worker store/API plumbing and the web UI, but never in recording, upload or orchestration code.
const ALLOWED = [
  /^packages\/core\/src\/(worker-contract|api-types)\.ts$/,
  /^packages\/app\/src\/worker-store(\.test)?\.ts$/,
  /^packages\/app\/src\/web\/api\/(context|types|workers)\.ts$/,
  /^packages\/web\/src\//,
  /^test\/(arch\/recording-warning-display-only|app\/web-api|web\/nodes-page)\.test\.ts$/,
];

describe("recordingWarningLimit is display-only (issue #351)", () => {
  it("is referenced only by config plumbing and the web UI", () => {
    const out = execFileSync("git", ["grep", "-l", "--untracked", "recordingWarningLimit", "--", "packages", "test"], { cwd: ROOT, encoding: "utf-8" });
    const offenders = out.split("\n").filter(Boolean).filter((f) => !ALLOWED.some((re) => re.test(f)));
    expect(offenders).toEqual([]);
  });
});
