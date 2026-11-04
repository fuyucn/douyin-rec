import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLivePumpPartName } from "@drec/core";
import { groupSessions } from "@drec/post-process";
import { scanRecordings } from "../../packages/orchestrator/src/scan.js";

const BASE = "anchor_2026-11-01_20-00-00";
const CURRENT = `${BASE}_000.live.ts`;
const CURRENT_N = `${BASE}_001-2.live.ts`;
const LEGACY = "1762000000000_000.live.ts";

describe("isLivePumpPartName", () => {
  it("matches current, legacy and path forms, case-insensitively", () => {
    expect(isLivePumpPartName(CURRENT)).toBe(true);
    expect(isLivePumpPartName(CURRENT_N)).toBe(true);
    expect(isLivePumpPartName(LEGACY)).toBe(true);
    expect(isLivePumpPartName(`/x/y/${CURRENT}`)).toBe(true);
    expect(isLivePumpPartName(`${BASE}_000.LIVE.TS`)).toBe(true);
  });

  it("does not match plain segments or look-alike suffixes", () => {
    expect(isLivePumpPartName(`${BASE}_000.ts`)).toBe(false);
    expect(isLivePumpPartName(`${BASE}_000.flv`)).toBe(false);
    expect(isLivePumpPartName(`${BASE}_000.live.ts.tmp`)).toBe(false);
    expect(isLivePumpPartName(`${BASE}_000.live.xml`)).toBe(false);
    expect(isLivePumpPartName(`${BASE}_000.olive.ts`)).toBe(false);
  });
});

describe("groupSessions ignores live-pump parts", () => {
  it("yields no session for current and legacy live parts (with their xml)", () => {
    const g = groupSessions([CURRENT, CURRENT_N, LEGACY, `${BASE}_000.live.xml`]);
    expect(g).toEqual({});
  });

  it("keeps normal segments when live parts sit beside them", () => {
    const g = groupSessions([`${BASE}_000.ts`, `${BASE}_001.ts`, CURRENT, LEGACY]);
    expect(Object.keys(g)).toEqual([BASE]);
    expect(g[BASE].ts).toEqual([`${BASE}_000.ts`, `${BASE}_001.ts`]);
  });
});

describe("scanRecordings ignores live-pump parts", () => {
  const ffprobe = async () => ({ durationSec: 10, startMs: 1, endMs: 2 });
  const mk = (files: string[]): string => {
    const rec = join(mkdtempSync(join(tmpdir(), "lpp-")), "recordings");
    const a = join(rec, "anchor");
    mkdirSync(a, { recursive: true });
    for (const f of files) writeFileSync(join(a, f), "x");
    return rec;
  };

  it("a dir holding only live parts + live.xml reports no recording", async () => {
    const rec = mk([CURRENT, LEGACY, `${BASE}_000.live.xml`]);
    expect(await scanRecordings(rec, {}, ffprobe)).toEqual([]);
  });

  it("mixed dir reports only the normal segment", async () => {
    const rec = mk([`${BASE}_000.ts`, CURRENT, LEGACY]);
    const rs = await scanRecordings(rec, {}, ffprobe);
    expect(rs.flatMap((r) => r.tsFiles.map((f) => f.split("/").pop()))).toEqual([`${BASE}_000.ts`]);
  });
});
