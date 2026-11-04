import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FINALIZING_HEARTBEAT_MS, ROLLING_ACTIVE_MAX_QUIET_MS, RecorderStateWriter, parseRecorderState, parseStartTicks,
  readRecorderStates, recorderActivity, recorderStateDir, recorderStatePath, roomActivities,
  type ProcProbe, type RecorderPhase, type RecorderStateFile,
} from "../../packages/core/src/recorder-state.js";

const NOW = 1_700_000_000_000;
const TICKS = 123456;
const BOOT = "boot-a";

function state(over: Partial<RecorderStateFile> = {}): RecorderStateFile {
  return {
    schemaVersion: 1, taskId: 7, platform: "douyin", roomSlug: "555", mode: "file",
    owner: { pid: 4242, startTicks: TICKS, bootId: BOOT },
    phase: "recording", session: null, heartbeatAt: NOW, finalizingSince: null, exit: null, updatedAt: NOW,
    ...over,
  };
}

const probe = (o: { ticks?: number | null; boot?: string | null } = {}): ProcProbe => ({
  startTicks: () => (o.ticks === undefined ? TICKS : o.ticks),
  bootId: () => (o.boot === undefined ? BOOT : o.boot),
});

const roots: string[] = [];
const root = (): string => {
  const r = mkdtempSync(join(tmpdir(), "drec-rec-state-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  vi.useRealTimers();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("recorderActivity", () => {
  const live: RecorderPhase[] = ["polling", "recording", "finalizing"];

  it.each(live)("%s: same pid start time and boot id → active", (phase) => {
    expect(recorderActivity(state({ phase }), NOW, probe())).toBe("active");
  });

  it.each(live)("%s: pid gone → dead", (phase) => {
    expect(recorderActivity(state({ phase }), NOW, probe({ ticks: null }))).toBe("dead");
  });

  it.each(live)("%s: pid reused (start time differs) → dead", (phase) => {
    expect(recorderActivity(state({ phase }), NOW, probe({ ticks: TICKS + 1 }))).toBe("dead");
  });

  it.each(live)("%s: reboot (boot id differs) → dead", (phase) => {
    expect(recorderActivity(state({ phase }), NOW, probe({ boot: "boot-b" }))).toBe("dead");
  });

  it.each(live)("%s: non-Linux file (null ticks / boot id) → dead (cannot verify)", (phase) => {
    expect(recorderActivity(state({ phase, owner: { pid: 1, startTicks: null, bootId: null } }), NOW, probe())).toBe("dead");
    expect(recorderActivity(state({ phase, owner: { pid: 1, startTicks: TICKS, bootId: null } }), NOW, probe())).toBe("dead");
    expect(recorderActivity(state({ phase, owner: { pid: 1, startTicks: null, bootId: BOOT } }), NOW, probe())).toBe("dead");
  });

  it("exited → ended regardless of the process facts", () => {
    const exited = state({ phase: "exited", exit: { code: 0, signal: null, at: NOW, draining: false } });
    expect(recorderActivity(exited, NOW, probe())).toBe("ended");
    expect(recorderActivity(exited, NOW, probe({ ticks: null, boot: null }))).toBe("ended");
    expect(recorderActivity({ ...exited, owner: { pid: 1, startTicks: null, bootId: null } }, NOW, probe())).toBe("ended");
  });

  it("finalizing: fresh heartbeat → active, exactly at the limit → active, past it → dead", () => {
    const f = (age: number) => state({ phase: "finalizing", heartbeatAt: NOW - age });
    expect(recorderActivity(f(1000), NOW, probe())).toBe("active");
    expect(recorderActivity(f(ROLLING_ACTIVE_MAX_QUIET_MS), NOW, probe())).toBe("active");
    expect(recorderActivity(f(ROLLING_ACTIVE_MAX_QUIET_MS + 1), NOW, probe())).toBe("dead");
  });

  it("finalizing: a fresh heartbeat does not save a tail that has been finalizing past the cap", () => {
    const f = (since: number | null) => state({ phase: "finalizing", heartbeatAt: NOW - 1000, finalizingSince: since });
    expect(recorderActivity(f(NOW - ROLLING_ACTIVE_MAX_QUIET_MS), NOW, probe())).toBe("active");
    expect(recorderActivity(f(NOW - ROLLING_ACTIVE_MAX_QUIET_MS - 1), NOW, probe())).toBe("dead");
    expect(recorderActivity(f(null), NOW, probe())).toBe("active"); // older bundle: heartbeat check only
  });

  it("recording / polling do not need a fresh heartbeat (owner verification is enough)", () => {
    for (const phase of ["recording", "polling"] as const) {
      expect(recorderActivity(state({ phase, heartbeatAt: NOW - 10 * ROLLING_ACTIVE_MAX_QUIET_MS }), NOW, probe())).toBe("active");
    }
  });
});

describe("parseStartTicks", () => {
  it("reads field 22 after the last ')' even when comm has spaces and parens", () => {
    // After ")" the fields run from field 3 (state); field 22 is the 20th token.
    const filler = Array.from({ length: 18 }, () => "0").join(" ");
    expect(parseStartTicks(`4242 (we ird) name) S ${filler} 987654 1 2`)).toBe(987654);
  });
  it("garbage → null", () => {
    expect(parseStartTicks("")).toBeNull();
    expect(parseStartTicks("1 (a) S 0 0")).toBeNull();
  });
});

describe("parseRecorderState / readRecorderStates", () => {
  it("round-trips a valid file; rejects unknown schema versions and bad shapes", () => {
    const s = state({ exit: { code: 1, signal: "SIGTERM", at: NOW, draining: true }, phase: "exited" });
    expect(parseRecorderState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseRecorderState({ ...s, schemaVersion: 2 })).toBeNull();
    expect(parseRecorderState({ ...s, phase: "weird" })).toBeNull();
    expect(parseRecorderState({ ...s, owner: null })).toBeNull();
    expect(parseRecorderState(null)).toBeNull();
  });

  it("lists rec-*.json, skips unparsable files with a log line, ignores other names and tmp leftovers", () => {
    const r = root();
    const dir = recorderStateDir(r);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rec-1.json"), JSON.stringify(state({ taskId: 1 })));
    writeFileSync(join(dir, "rec-2.json"), "{not json");
    writeFileSync(join(dir, "rec-3.json"), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(join(dir, "rec-4.json.99.abcd.tmp"), "x");
    writeFileSync(join(dir, "task-1.log"), "x");
    const log: string[] = [];
    const got = readRecorderStates(r, (m) => log.push(m));
    expect(got.map((g) => g.taskId)).toEqual([1]);
    expect(log).toHaveLength(2);
    expect(log.join("\n")).toContain("rec-2.json");
    expect(log.join("\n")).toContain("rec-3.json");
  });

  it("missing run dir → empty", () => {
    expect(readRecorderStates(root())).toEqual([]);
  });
});

describe("roomActivities", () => {
  it("one entry per room; a dead or exited file still marks the room as having a state file", () => {
    const dead = state({ taskId: 1, roomSlug: "a", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    const ended = state({ taskId: 2, roomSlug: "b", phase: "exited", exit: { code: 0, signal: null, at: NOW, draining: false } });
    const rec = state({ taskId: 3, roomSlug: "c" });
    const fin = state({ taskId: 4, roomSlug: "d", phase: "finalizing" });
    const poll = state({ taskId: 5, roomSlug: "e", phase: "polling" });
    const p: ProcProbe = {
      startTicks: (pid) => (pid === 4242 ? TICKS : null),
      bootId: () => BOOT,
    };
    const m = roomActivities([dead, ended, rec, fin, poll], NOW, p);
    expect([...m.keys()].sort()).toEqual(["douyin:a", "douyin:b", "douyin:c", "douyin:d", "douyin:e"]);
    expect(m.get("douyin:a")).toMatchObject({ recording: false, finalizing: false });
    expect(m.get("douyin:b")).toMatchObject({ recording: false, finalizing: false });
    expect(m.get("douyin:c")).toMatchObject({ recording: true, finalizing: false });
    expect(m.get("douyin:d")).toMatchObject({ recording: false, finalizing: true });
    expect(m.get("douyin:e")).toMatchObject({ recording: false, finalizing: false });
  });
});

describe("RecorderStateWriter", () => {
  const mk = (r: string, extra: Partial<ConstructorParameters<typeof RecorderStateWriter>[0]> = {}) => {
    let t = NOW;
    const w = new RecorderStateWriter({
      file: recorderStatePath(r, 7), taskId: 7, platform: "douyin", roomSlug: "555", mode: "live",
      owner: { pid: 4242, startTicks: TICKS, bootId: BOOT }, now: () => t, ...extra,
    });
    return { w, tick: (ms: number) => { t += ms; } };
  };
  const read = (r: string): RecorderStateFile => JSON.parse(readFileSync(recorderStatePath(r, 7), "utf-8")) as RecorderStateFile;

  it("writes the initial polling state atomically (no tmp leftovers), then follows phase changes", () => {
    const r = root();
    const { w } = mk(r);
    w.start();
    expect(read(r)).toMatchObject({ schemaVersion: 1, taskId: 7, platform: "douyin", roomSlug: "555", mode: "live", phase: "polling", session: null, exit: null });
    w.setPhase("recording", "base-1");
    expect(read(r)).toMatchObject({ phase: "recording", session: "base-1" });
    w.setPhase("finalizing");
    expect(read(r)).toMatchObject({ phase: "finalizing", session: "base-1" });
    w.setPhase("polling", null); // session rotation: the previous session must not stay attached
    expect(read(r)).toMatchObject({ phase: "polling", session: null });
    expect(readdirSync(recorderStateDir(r)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("finalizingSince is set on entering finalizing, kept across heartbeats, cleared on leaving", () => {
    vi.useFakeTimers();
    const r = root();
    const { w, tick } = mk(r);
    w.start();
    w.setPhase("recording");
    expect(read(r).finalizingSince).toBeNull();
    w.setPhase("finalizing");
    const since = read(r).finalizingSince;
    expect(since).not.toBeNull();
    tick(FINALIZING_HEARTBEAT_MS);
    vi.advanceTimersByTime(FINALIZING_HEARTBEAT_MS);
    expect(read(r).finalizingSince).toBe(since);
    expect(read(r).heartbeatAt).toBeGreaterThan(since!);
    w.setPhase("polling");
    expect(read(r).finalizingSince).toBeNull();
  });

  it("does not rewrite on a repeated identical phase", () => {
    const write = vi.fn();
    const { w } = mk(root(), { write });
    w.start();
    w.setPhase("recording");
    w.setPhase("recording");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("refreshes heartbeatAt every 30s only while finalizing", () => {
    vi.useFakeTimers();
    const r = root();
    const { w, tick } = mk(r);
    w.start();
    w.setPhase("recording");
    const before = read(r).heartbeatAt;
    tick(FINALIZING_HEARTBEAT_MS * 3);
    vi.advanceTimersByTime(FINALIZING_HEARTBEAT_MS * 3);
    expect(read(r).heartbeatAt).toBe(before); // recording: no timer
    w.setPhase("finalizing");
    const t0 = read(r).heartbeatAt;
    tick(FINALIZING_HEARTBEAT_MS);
    vi.advanceTimersByTime(FINALIZING_HEARTBEAT_MS);
    expect(read(r).heartbeatAt).toBe(t0 + FINALIZING_HEARTBEAT_MS);
    w.setPhase("polling");
    const t1 = read(r).heartbeatAt;
    tick(FINALIZING_HEARTBEAT_MS * 2);
    vi.advanceTimersByTime(FINALIZING_HEARTBEAT_MS * 2);
    expect(read(r).heartbeatAt).toBe(t1); // timer stopped
  });

  it("the exit hook writes exited with code, signal and draining; later phase reports are ignored", () => {
    const r = root();
    const { w } = mk(r);
    const proc = new EventEmitter();
    w.start();
    w.installExitHook(proc as unknown as NodeJS.Process);
    w.setPhase("recording");
    w.noteSignal("SIGUSR2");
    w.noteDraining();
    proc.emit("exit", 0);
    expect(read(r)).toMatchObject({ phase: "exited", exit: { code: 0, signal: "SIGUSR2", draining: true } });
    expect(typeof read(r).exit!.at).toBe("number");
    w.setPhase("recording"); // e.g. a late callback after the exit hook ran
    expect(read(r).phase).toBe("exited");
    proc.emit("exit", 1); // idempotent
    expect(read(r).exit!.code).toBe(0);
  });

  it("exit without a signal records signal null / draining false", () => {
    const r = root();
    const { w } = mk(r);
    w.start();
    w.markExited(1);
    expect(read(r).exit).toMatchObject({ code: 1, signal: null, draining: false });
  });

  it("a write failure is logged once, never thrown, and later writes still go through", () => {
    const log = vi.fn();
    let fail = true;
    const written: string[] = [];
    const { w } = mk(root(), {
      log,
      write: (_f, data) => { if (fail) throw new Error("ENOSPC"); written.push(data); },
    });
    expect(() => {
      w.start();
      w.setPhase("recording");
      w.setPhase("finalizing");
      w.setPhase("polling");
    }).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("ENOSPC");
    fail = false;
    w.setPhase("recording");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]).phase).toBe("recording");
  });

  it("creates the run directory on demand", () => {
    const r = root();
    expect(existsSync(recorderStateDir(r))).toBe(false);
    mk(r).w.start();
    expect(existsSync(recorderStatePath(r, 7))).toBe(true);
  });
});
