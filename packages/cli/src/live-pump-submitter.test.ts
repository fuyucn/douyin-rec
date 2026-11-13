/**
 * The zero-disk submitter stays off unless the flag is set: a half-wired upload path is worse
 * than the legacy one (plans/049 stage 2b-2c).
 */
import { describe, it, expect } from "vitest";
import { buildLivePumpSubmitter } from "./live-pump-submitter.js";

const base = {
  cookiesPath: "/tmp/cookies.json",
  spoolDir: "/tmp/spool",
  pumpRoom: "r",
};

describe("buildLivePumpSubmitter", () => {
  it("returns null when the flag is off", () => {
    const s = buildLivePumpSubmitter({ ...base, env: () => undefined });
    expect(s).toBeNull();
  });

  it("returns the three operations when the flag is on", () => {
    const s = buildLivePumpSubmitter({ ...base, env: (k) => (k === "DREC_LIVE_PUMP_DRIVER" ? "1" : undefined) });
    expect(s).not.toBeNull();
    expect(typeof s!.ensureStreamedArchive).toBe("function");
    expect(typeof s!.appendStreamedPart).toBe("function");
    expect(typeof s!.verify).toBe("function");
  });
});
