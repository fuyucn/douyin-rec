// Issue #699: the queue upload-part transfer watchdog relies on `ss -tinpH` TCP bytes_acked.
// Without iproute2 in the runtime image, readTcpAcked returns null, stall detection pauses,
// and a hung biliup process can block ordered parts until maxWallMs (24h).
// Unit tests do not exercise the container package list, so guard the Dockerfile binding here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

describe("Docker runtime image provides ss (iproute2) for biliup transfer watchdog (#699)", () => {
  it("installs iproute2 in both master and worker Dockerfile runtime variants", () => {
    const text = readFileSync(join(ROOT, "Dockerfile"), "utf-8");
    // Both master and worker runtime branches run apt-get install and must include iproute2.
    const installs = text
      .split("\n")
      .filter((line) => /apt-get install -y --no-install-recommends/.test(line));
    expect(installs.length).toBe(2);
    for (const line of installs) {
      expect(line).toContain("iproute2");
    }
  });

  it("keeps biliup-progress TCP sampling bound to ss from iproute2", () => {
    const src = readFileSync(join(ROOT, "packages", "bilibili-upload", "src", "biliup-progress.ts"), "utf-8");
    // Scan every execFile/execFileSync call site so adding or switching to another binary fails this guard.
    const commands = [...src.matchAll(/execFile(?:Sync)?\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      expect(cmd).toBe("ss");
    }
    expect(src).toContain("-tinpH");
  });
});
