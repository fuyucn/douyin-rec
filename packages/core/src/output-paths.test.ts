import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jobLogFileName, jobLogPathCandidates, legacyStageSessionDir, recordingRoomDir, recordingRoomDirCandidates, resolveJobLogPath, roomDirName,
  sanitizePathSegment, sanitizeRoomName, stageSessionDir, parseOutputLayout, parseRoomDirName, anchorNameOfSessionBase, stageSessionDirCandidates, findRoomDir, ROOM_NAME_MAX_BYTES,
} from "./output-paths.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "outpaths-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const KEY = "douyin:1234567:2026-10-20";
const KEY_HHMM = "douyin:1234567:2026-10-20_1830";

describe("sanitizePathSegment (unchanged legacy rule)", () => {
  it("drops illegal and control chars, collapses whitespace, never truncates", () => {
    expect(sanitizePathSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    expect(sanitizePathSegment("a b\tc   d")).toBe("a bc d");
    expect(sanitizePathSegment("   ")).toBe("");
    expect(sanitizePathSegment("x".repeat(300))).toHaveLength(300);
  });
});

describe("sanitizeRoomName", () => {
  it("NFC-normalises", () => {
    expect(sanitizeRoomName("e\u0301")).toBe("\u00e9");
  });
  it("handles emoji, full-width and slashes", () => {
    expect(sanitizeRoomName("小苏打🎀／ａｂ")).toBe("小苏打🎀／ａｂ"); // full-width slash is not illegal
    expect(sanitizeRoomName("a/b")).toBe("ab");
  });
  it("clamps to the byte limit on a code point boundary", () => {
    const out = sanitizeRoomName("🎀".repeat(100));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(ROOM_NAME_MAX_BYTES);
    expect([...out].every((c) => c === "🎀")).toBe(true);
    expect(Buffer.byteLength(sanitizeRoomName("名".repeat(100)))).toBe(120);
  });
});

describe("stageSessionDir", () => {
  it("default layout is legacy", () => {
    expect(stageSessionDir(root, KEY)).toBe(join(root, "douyin_1234567_2026-10-20"));
    expect(legacyStageSessionDir(root, KEY_HHMM)).toBe(join(root, "douyin_1234567_2026-10-20_1830"));
  });
  it("room layout: new room dir uses the anchor name, falls back to the room slug", () => {
    expect(stageSessionDir(root, KEY, { layout: "room", anchorName: "Alice" })).toBe(join(root, "Alice_douyin_1234567", "2026-10-20"));
    expect(stageSessionDir(root, KEY, { layout: "room" })).toBe(join(root, "1234567_douyin_1234567", "2026-10-20"));
    expect(stageSessionDir(root, KEY_HHMM, { layout: "room", anchorName: "Alice" })).toBe(join(root, "Alice_douyin_1234567", "2026-10-20_1830"));
  });
  it("room layout: existing dir is found by suffix, the anchor name (even a new one) is ignored", () => {
    mkdirSync(join(root, "OldName_douyin_1234567"));
    expect(stageSessionDir(root, KEY, { layout: "room", anchorName: "Renamed" })).toBe(join(root, "OldName_douyin_1234567", "2026-10-20"));
    expect(stageSessionDir(root, KEY, { layout: "room" })).toBe(join(root, "OldName_douyin_1234567", "2026-10-20"));
  });
  it("sticky legacy: an existing legacy session dir wins", () => {
    mkdirSync(join(root, "douyin_1234567_2026-10-20"));
    mkdirSync(join(root, "OldName_douyin_1234567"));
    expect(stageSessionDir(root, KEY, { layout: "room", anchorName: "Alice" })).toBe(join(root, "douyin_1234567_2026-10-20"));
    // another session of the same room is not pinned by that one
    expect(stageSessionDir(root, "douyin:1234567:2026-10-21", { layout: "room" })).toBe(join(root, "OldName_douyin_1234567", "2026-10-21"));
  });
  it("platform and room are part of the suffix: other rooms never match", () => {
    mkdirSync(join(root, "X_douyin_91234"));
    mkdirSync(join(root, "X_bilibili_1234"));
    expect(findRoomDir(root, "douyin", "1234")).toBeNull();
  });
  it("several dirs with the same suffix: oldest wins and warns", () => {
    mkdirSync(join(root, "B_douyin_1234567"));
    mkdirSync(join(root, "A_douyin_1234567"));
    const t0 = new Date(2020, 0, 1);
    utimesSync(join(root, "B_douyin_1234567"), t0, t0);
    const warns: string[] = [];
    const got = findRoomDir(root, "douyin", "1234567", (m) => warns.push(m));
    expect(got).not.toBeNull();
    expect(warns).toHaveLength(1);
    // never creates a third one
    expect(stageSessionDir(root, KEY, { layout: "room", anchorName: "C", warn: () => {} }).startsWith(got!)).toBe(true);
  });
  it("an existing session dir is reused whatever the configured layout is (no orphaning on a switch)", () => {
    // started under the room layout, switch turned back to legacy: still the room path
    mkdirSync(join(root, "N_douyin_1234567", "2026-10-20"), { recursive: true });
    expect(stageSessionDir(root, KEY)).toBe(join(root, "N_douyin_1234567", "2026-10-20"));
    // a room dir without that session dir does not capture a legacy-layout session
    expect(stageSessionDir(root, "douyin:1234567:2026-10-22")).toBe(join(root, "douyin_1234567_2026-10-22"));
    expect(stageSessionDir(root, "douyin:1234567:2026-10-22", { layout: "room" })).toBe(join(root, "N_douyin_1234567", "2026-10-22"));
  });
  it("malformed streamKey falls back to legacy, never throws", () => {
    expect(stageSessionDir(root, "weird", { layout: "room" })).toBe(join(root, "weird"));
  });
  it("candidates cover legacy and the suffix-matched room dir", () => {
    expect(stageSessionDirCandidates(root, KEY)).toEqual([join(root, "douyin_1234567_2026-10-20")]);
    mkdirSync(join(root, "N_douyin_1234567"));
    expect(stageSessionDirCandidates(root, KEY)).toEqual([join(root, "douyin_1234567_2026-10-20"), join(root, "N_douyin_1234567", "2026-10-20")]);
  });
});

describe("recordingRoomDir", () => {
  it("legacy: first non-empty sanitised name, null when none", () => {
    expect(recordingRoomDir(root, ["///", " Bob "])).toBe(join(root, "Bob"));
    expect(recordingRoomDir(root, [null, ""])).toBeNull();
  });
  it("room layout: suffix match first (rename-proof), else a new room dir; legacy dirs are history, not reused", () => {
    const room = { platform: "douyin", roomSlug: "77" };
    expect(recordingRoomDir(root, "Bob", room, { layout: "room" })).toBe(join(root, "Bob_douyin_77"));
    mkdirSync(join(root, "Bob")); // an old-layout dir for the same anchor exists: new sessions still go to the room dir
    expect(recordingRoomDir(root, "Bob", room, { layout: "room" })).toBe(join(root, "Bob_douyin_77"));
    mkdirSync(join(root, "Old_douyin_77"));
    expect(recordingRoomDir(root, "Carol", room, { layout: "room" })).toBe(join(root, "Old_douyin_77"));
    // legacy layout is untouched by any of this
    expect(recordingRoomDir(root, "Carol", room)).toBe(join(root, "Carol"));
  });
  it("candidates list both old and new directories once", () => {
    mkdirSync(join(root, "Old_douyin_77"));
    expect(recordingRoomDirCandidates(root, "Bob", { platform: "douyin", roomSlug: "77" })).toEqual([join(root, "Bob"), join(root, "Old_douyin_77")]);
  });
  it("roomDirName falls back to the slug", () => {
    expect(roomDirName("douyin", "77", "")).toBe("77_douyin_77");
  });
});

describe("resolveJobLogPath", () => {
  it("legacy by default", () => {
    expect(resolveJobLogPath(root, KEY)).toBe(join(root, "douyin_1234567_2026-10-20", "job.log"));
  });
  it("room layout writes under logs/hub/<platform>_<room>, outside stage", () => {
    const logs = join(root, "logs");
    expect(resolveJobLogPath(join(root, "stage"), KEY, { layout: "room", logsRoot: logs })).toBe(join(logs, "hub", "douyin_1234567", jobLogFileName(KEY)));
    expect(jobLogFileName(KEY_HHMM)).toBe("douyin_1234567_2026-10-20_1830.log");
  });
  it("sticky legacy log and missing logsRoot", () => {
    const stage = join(root, "stage");
    mkdirSync(join(stage, "douyin_1234567_2026-10-20"), { recursive: true });
    writeFileSync(join(stage, "douyin_1234567_2026-10-20", "job.log"), "x");
    expect(resolveJobLogPath(stage, KEY, { layout: "room", logsRoot: join(root, "logs") })).toBe(join(stage, "douyin_1234567_2026-10-20", "job.log"));
    expect(resolveJobLogPath(stage, "douyin:1:2026-10-21", { layout: "room" })).toBe(join(stage, "douyin_1_2026-10-21", "job.log"));
  });
});

describe("jobLogPathCandidates", () => {
  const stage = () => join(root, "stage");
  const logs = () => join(root, "logs");
  it("new location first, legacy second; both always listed", () => {
    const c = jobLogPathCandidates(stage(), KEY, logs());
    expect(c).toEqual([join(logs(), "hub", "douyin_1234567", jobLogFileName(KEY)), join(stage(), "douyin_1234567_2026-10-20", "job.log")]);
  });
  it("sticky legacy goes first but the new path is still a candidate (deletion must reach it)", () => {
    mkdirSync(join(stage(), "douyin_1234567_2026-10-20"), { recursive: true });
    writeFileSync(join(stage(), "douyin_1234567_2026-10-20", "job.log"), "x");
    const c = jobLogPathCandidates(stage(), KEY, logs());
    expect(c).toHaveLength(2);
    expect(c[0]).toBe(join(stage(), "douyin_1234567_2026-10-20", "job.log"));
    expect(c[1]).toBe(join(logs(), "hub", "douyin_1234567", jobLogFileName(KEY)));
  });
  it("malformed key: legacy only", () => {
    expect(jobLogPathCandidates(stage(), "weird", logs())).toEqual([join(stage(), "weird", "job.log")]);
  });
});

describe("layout switch and name helpers", () => {
  it("parseOutputLayout: only the exact string room enables it", () => {
    expect(parseOutputLayout("room")).toBe("room");
    for (const v of ["legacy", "ROOM", "", undefined, null, 1, {}]) expect(parseOutputLayout(v)).toBe("legacy");
  });
  it("parseRoomDirName: rightmost known platform marker, anchor names containing it cannot hijack", () => {
    const ids = ["douyin", "bilibili"];
    expect(parseRoomDirName("Alice_douyin_1234", ids)).toEqual({ platform: "douyin", roomSlug: "1234" });
    expect(parseRoomDirName("a_douyin_b_bilibili_99", ids)).toEqual({ platform: "bilibili", roomSlug: "99" });
    expect(parseRoomDirName("a_douyin_b_douyin_7", ids)).toEqual({ platform: "douyin", roomSlug: "7" });
    expect(parseRoomDirName("Alice", ids)).toBeNull();
    expect(parseRoomDirName("_douyin_5", ids)).toBeNull();
    expect(parseRoomDirName("x_douyin_", ids)).toBeNull();
  });
  it("anchorNameOfSessionBase: strips the stamp and segment suffix", () => {
    expect(anchorNameOfSessionBase("Alice_2026-10-20_08-00-00")).toBe("Alice");
    expect(anchorNameOfSessionBase("Al_ice_2026-10-20_08-00-00-PART01")).toBe("Al_ice");
    expect(anchorNameOfSessionBase("no-stamp")).toBeNull();
  });
});
