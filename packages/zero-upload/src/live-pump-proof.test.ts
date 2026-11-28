import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendConfirmedJournal, confirmLivePumpPart, isLivePumpPartObserved,
  livePumpHasUnconfirmed, livePumpStatePath, LivePumpSession, readLivePumpState,
  requiresLivePumpProof, writeLivePumpState, type LivePumpState,
} from "./live-pump.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sourceFingerprint(path: string) {
  const stat = lstatSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "live-proof-"));
  roots.push(root);
  const cookiesPath = join(root, "cookies.json");
  writeFileSync(cookiesPath, JSON.stringify({ cookie_info: { cookies: [{ name: "bili_jct", value: "test" }] } }));
  const spoolPath = join(root, "part.ts");
  writeFileSync(spoolPath, "data");
  const input = { index: 0, spoolPath, stem: "native-part", title: "P1", bytes: 4, durationSec: 1 };
  const statePath = livePumpStatePath(root, "test-room");
  let visible = false;
  let archiveId = "test-archive";
  const writes = vi.fn();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    if (init?.method === "POST") {
      writes(path, readLivePumpState(statePath));
      return Response.json({ code: 0, data: { aid: 7, bvid: "test-archive" } });
    }
    return Response.json({ code: 0, data: {
      archive: { aid: 7, bvid: archiveId, title: "test", tid: 21 },
      videos: [{ filename: visible ? input.stem : "another-part" }],
    } });
  }) as unknown as typeof fetch;
  const options = { room: "test-room", spoolDir: root, cookiesPath, title: "test", tid: 21, tag: "test", fetchImpl, log: () => {} };
  return { root, statePath, spoolPath, input, options, writes,
    show: (id = "test-archive") => { visible = true; archiveId = id; } };
}

describe("live publication proof", () => {
  it.each(["corrupt", "future-proof-version"] as const)("preserves %s state and refuses to initialize a fresh archive", (kind) => {
    const test = fixture();
    const state = new LivePumpSession(test.options).snapshot();
    const original = kind === "corrupt" ? "{unfinished upload state" : JSON.stringify({ ...state, submissionProofVersion: 2 });
    writeFileSync(test.statePath, original);
    expect(readLivePumpState(test.statePath)).toBeNull();
    expect(() => new LivePumpSession(test.options)).toThrow(/unreadable|incompatible/);
    expect(readFileSync(test.statePath, "utf8")).toBe(original);
    expect(readdirSync(test.root).filter((name) => name.includes(".archived"))).toEqual([]);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).not.toHaveBeenCalled();
  });

  it("retains observed sources without an archive identity and refuses another POST", async () => {
    const test = fixture();
    test.show();
    expect((await new LivePumpSession({ ...test.options, cleanupConfirmedSpool: false }).submitPart(test.input)).ok).toBe(true);
    const state = readLivePumpState(test.statePath)!;
    expect(isLivePumpPartObserved(state.parts[0]!)).toBe(true);
    expect(state.parts[0]?.sourceFp).toEqual(sourceFingerprint(test.spoolPath));
    delete state.bvid;
    delete state.aid;
    writeLivePumpState(test.statePath, state);
    const original = readFileSync(test.statePath, "utf8");
    test.writes.mockClear();
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.recover()).ok).toBe(true);
    await expect(resumed.submitPart(test.input)).resolves.toMatchObject({ ok: false, needsManual: true, error: expect.stringContaining("archive identity is missing") });
    expect(test.writes).not.toHaveBeenCalled();
    expect(readFileSync(test.statePath, "utf8")).toBe(original);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
  });

  it("refuses to bind an observed native key to a different local part and retains both sources", async () => {
    const test = fixture();
    test.show();
    expect((await new LivePumpSession({ ...test.options, cleanupConfirmedSpool: false }).submitPart(test.input)).ok).toBe(true);
    const successorPath = join(test.root, "successor.ts");
    writeFileSync(successorPath, "next");
    const original = readFileSync(test.statePath, "utf8");
    test.writes.mockClear();
    const resumed = new LivePumpSession(test.options);
    await expect(resumed.submitPart({ ...test.input, index: 1, spoolPath: successorPath })).resolves.toMatchObject({
      ok: false, needsManual: true, error: expect.stringContaining("already bound to another local part"),
    });
    expect(test.writes).not.toHaveBeenCalled();
    expect(readFileSync(test.statePath, "utf8")).toBe(original);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(readFileSync(successorPath, "utf8")).toBe("next");
  });

  it("holds malformed observed rows without replaying or spinning recovery forever", async () => {
    const test = fixture();
    await new LivePumpSession(test.options).submitPart(test.input);
    const state = readLivePumpState(test.statePath)!;
    delete state.pending;
    Object.assign(state.parts[0]!, { confirmed: true, proof: "observed", nativeKey: "wrong-key", observedAt: 1 });
    writeLivePumpState(test.statePath, state);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.resubmitAllUnconfirmed()).ok).toBe(false);
    expect((await resumed.submitPart(test.input)).ok).toBe(false);
    expect(existsSync(test.spoolPath)).toBe(true);
    expect(test.writes).toHaveBeenCalledTimes(1);
  });
  it("rejects a different archive even when the exact native key is present", async () => {
    const test = fixture();
    const session = new LivePumpSession(test.options);
    await session.submitPart(test.input);
    test.show("different-archive");
    expect(await session.recover()).toMatchObject({ ok: false, needsManual: true });
    expect(readLivePumpState(test.statePath)!.pending).toBeDefined();
    expect(existsSync(test.spoolPath)).toBe(true);
    expect(test.writes).toHaveBeenCalledTimes(1);
  });
  it("persists the source fingerprint before POST and retains it across accepted restart", async () => {
    const test = fixture();
    const sourceFp = sourceFingerprint(test.spoolPath);
    const session = new LivePumpSession(test.options);
    expect((await session.submitPart(test.input)).ok).toBe(false);
    expect(test.writes).toHaveBeenCalledWith("/x/vu/web/add/v3", expect.objectContaining({
      pending: expect.objectContaining({ submissionState: "intent", stem: test.input.stem, sourceFp }),
    }));
    const accepted = readLivePumpState(test.statePath)!;
    expect(accepted.pending).toMatchObject({ submissionState: "accepted", stem: test.input.stem, sourceFp });
    expect(accepted.parts[0]).toMatchObject({ confirmed: false, proof: "accepted", sourceFp });
    expect((await session.submitPart(test.input)).ok).toBe(false);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.recover()).ok).toBe(false);
    expect(readLivePumpState(test.statePath)!.pending?.sourceFp).toEqual(sourceFp);
    expect(readLivePumpState(test.statePath)!.parts[0]?.sourceFp).toEqual(sourceFp);
    expect(test.writes).toHaveBeenCalledTimes(1);
    expect(existsSync(test.spoolPath)).toBe(true);
    test.show();
    expect((await resumed.recover()).ok).toBe(true);
    expect(isLivePumpPartObserved(readLivePumpState(test.statePath)!.parts[0]!)).toBe(true);
    expect(readLivePumpState(test.statePath)!.parts[0]?.sourceFp).toEqual(sourceFp);
    expect(existsSync(test.spoolPath)).toBe(false);
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("restores observation, not upload, for an accepted row whose pending projection is absent", async () => {
    const test = fixture();
    const sourceFp = sourceFingerprint(test.spoolPath);
    expect((await new LivePumpSession(test.options).submitPart(test.input)).ok).toBe(false);
    const state = readLivePumpState(test.statePath)!;
    expect(state.parts[0]?.sourceFp).toEqual(sourceFp);
    delete state.pending;
    writeLivePumpState(test.statePath, state);
    writeFileSync(test.spoolPath, "changed source");
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.resubmitUnconfirmedPart()).ok).toBe(false);
    expect(readLivePumpState(test.statePath)!.pending).toMatchObject({ submissionState: "accepted", sourceFp });
    test.show();
    expect((await resumed.recover()).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toEqual(sourceFp);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("changed source");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("retains a same-path replacement with equal size and mtime but a different inode", async () => {
    const test = fixture();
    const timestamp = new Date(1_700_000_000_000);
    utimesSync(test.spoolPath, timestamp, timestamp);
    const sourceFp = sourceFingerprint(test.spoolPath);
    expect((await new LivePumpSession(test.options).submitPart(test.input)).ok).toBe(false);
    const replacementPath = join(test.root, "replacement.ts");
    writeFileSync(replacementPath, "swap");
    utimesSync(replacementPath, timestamp, timestamp);
    renameSync(replacementPath, test.spoolPath);
    const replacementFp = sourceFingerprint(test.spoolPath);
    expect(replacementFp).toMatchObject({ size: sourceFp.size, mtimeMs: sourceFp.mtimeMs, dev: sourceFp.dev });
    expect(replacementFp.ino).not.toBe(sourceFp.ino);
    test.show();
    expect((await new LivePumpSession(test.options).recover()).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toEqual(sourceFp);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("swap");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it.each(["content", "mtime"] as const)("retains the source when its %s changes after submission", async (change) => {
    const test = fixture();
    const sourceFp = sourceFingerprint(test.spoolPath);
    expect((await new LivePumpSession(test.options).submitPart(test.input)).ok).toBe(false);
    if (change === "content") writeFileSync(test.spoolPath, "edit");
    const changedTime = new Date(sourceFp.mtimeMs + 10_000);
    utimesSync(test.spoolPath, changedTime, changedTime);
    const changedFp = sourceFingerprint(test.spoolPath);
    expect(changedFp).toMatchObject({ size: sourceFp.size, dev: sourceFp.dev, ino: sourceFp.ino });
    expect(changedFp.mtimeMs).not.toBe(sourceFp.mtimeMs);
    test.show();
    expect((await new LivePumpSession(test.options).recover()).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toEqual(sourceFp);
    expect(readFileSync(test.spoolPath, "utf8")).toBe(change === "content" ? "edit" : "data");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("never invents a missing historical source fingerprint for an observed row", async () => {
    const test = fixture();
    test.show();
    expect((await new LivePumpSession({ ...test.options, cleanupConfirmedSpool: false }).submitPart(test.input)).ok).toBe(true);
    const state = readLivePumpState(test.statePath)!;
    delete state.submissionProofVersion;
    delete state.parts[0]!.sourceFp;
    writeLivePumpState(test.statePath, state);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.recover()).ok).toBe(true);
    expect((await resumed.submitPart(test.input)).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toBeUndefined();
    expect(resumed.snapshot().parts[0]?.sourceFp).toBeUndefined();
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("does not recapture a missing fingerprint when reconstructing historical accepted intent", async () => {
    const test = fixture();
    expect((await new LivePumpSession(test.options).submitPart(test.input)).ok).toBe(false);
    const state = readLivePumpState(test.statePath)!;
    delete state.pending;
    delete state.parts[0]!.sourceFp;
    writeLivePumpState(test.statePath, state);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.recover()).ok).toBe(false);
    expect(readLivePumpState(test.statePath)!.pending?.submissionState).toBe("accepted");
    expect(readLivePumpState(test.statePath)!.pending?.sourceFp).toBeUndefined();
    test.show();
    expect((await resumed.recover()).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toBeUndefined();
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("retains a substituted spool symlink and leaves its target intact", async () => {
    const test = fixture();
    const sourceFp = sourceFingerprint(test.spoolPath);
    expect((await new LivePumpSession(test.options).submitPart(test.input)).ok).toBe(false);
    const originalPath = join(test.root, "original.ts");
    const targetPath = join(test.root, "target.ts");
    renameSync(test.spoolPath, originalPath);
    writeFileSync(targetPath, "next");
    symlinkSync(targetPath, test.spoolPath);
    test.show();
    expect((await new LivePumpSession(test.options).recover()).ok).toBe(true);
    const observed = readLivePumpState(test.statePath)!.parts[0]!;
    expect(isLivePumpPartObserved(observed)).toBe(true);
    expect(observed.sourceFp).toEqual(sourceFp);
    expect(lstatSync(test.spoolPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe("next");
    expect(readFileSync(originalPath, "utf8")).toBe("data");
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("never lets a legacy journal clear protected intent or authorize queue confirmation", async () => {
    const test = fixture();
    await new LivePumpSession(test.options).submitPart(test.input);
    const state = readLivePumpState(test.statePath)!;
    appendConfirmedJournal(test.statePath, { index: 0, bv: "test-archive", at: Date.now(), createdAt: state.createdAt });
    const resumed = new LivePumpSession(test.options);
    expect(livePumpHasUnconfirmed(test.statePath)).toBe(true);
    expect(resumed.snapshot().pending).toBeDefined();
    expect(confirmLivePumpPart(test.statePath, 0, "test-archive", { size: 4, mtimeMs: 1 }).ok).toBe(false);
    expect(existsSync(test.spoolPath)).toBe(true);
  });

  it("does not age protected unresolved work into a new archive", async () => {
    const test = fixture();
    await new LivePumpSession(test.options).submitPart(test.input);
    const state = readLivePumpState(test.statePath)!;
    state.updatedAt = 1;
    writeLivePumpState(test.statePath, state);
    const resumed = new LivePumpSession(test.options);
    expect(resumed.snapshot().createdAt).toBe(state.createdAt);
    expect(resumed.snapshot().pending?.stem).toBe(test.input.stem);
  });

  it("requires exact native identity and a positive observation timestamp", () => {
    const part: LivePumpState["parts"][number] = {
      index: 0, spoolPath: "unused", filename: "unused", stem: "one", title: "P1",
      bytes: 4, durationSec: 1, confirmed: true, proof: "observed", nativeKey: "two", observedAt: 1,
    };
    expect(isLivePumpPartObserved(part)).toBe(false);
    part.nativeKey = "one";
    part.observedAt = NaN;
    expect(isLivePumpPartObserved(part)).toBe(false);
    part.observedAt = 1;
    expect(isLivePumpPartObserved(part)).toBe(true);
    expect(requiresLivePumpProof({ parts: [part] } as LivePumpState)).toBe(true);
  });

  it("does not delete from in-memory confirmation when the durable state is unreadable", async () => {
    const test = fixture();
    test.show();
    const options = { ...test.options, cleanupConfirmedSpool: false };
    const session = new LivePumpSession(options);
    expect((await session.submitPart(test.input)).ok).toBe(true);
    options.cleanupConfirmedSpool = true;
    writeFileSync(test.spoolPath, "data");
    const persisted = readFileSync(test.statePath, "utf8");
    expect(persisted).toContain("observed");
    rmSync(test.statePath);
    mkdirSync(test.statePath);
    expect((await session.recover()).ok).toBe(true);
    expect(existsSync(test.spoolPath)).toBe(true);
  });
});
