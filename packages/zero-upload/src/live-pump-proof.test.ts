import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendConfirmedJournal, confirmLivePumpPart, isLivePumpPartObserved,
  livePumpHasUnconfirmed, livePumpStatePath, LivePumpSession, readLivePumpState,
  requiresLivePumpProof, writeLivePumpState, type LivePumpState,
} from "./live-pump.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
      writes(path);
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
  it("retains accepted identity and spool across restart without replaying the POST", async () => {
    const test = fixture();
    const session = new LivePumpSession(test.options);
    expect((await session.submitPart(test.input)).ok).toBe(false);
    const accepted = readLivePumpState(test.statePath)!;
    expect(accepted.pending).toMatchObject({ submissionState: "accepted", stem: test.input.stem });
    expect(accepted.parts[0]).toMatchObject({ confirmed: false, proof: "accepted" });
    expect((await session.submitPart(test.input)).ok).toBe(false);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.recover()).ok).toBe(false);
    expect(test.writes).toHaveBeenCalledTimes(1);
    expect(existsSync(test.spoolPath)).toBe(true);
    test.show();
    expect((await resumed.recover()).ok).toBe(true);
    expect(isLivePumpPartObserved(readLivePumpState(test.statePath)!.parts[0]!)).toBe(true);
    expect(existsSync(test.spoolPath)).toBe(false);
    expect(test.writes).toHaveBeenCalledTimes(1);
  });

  it("restores observation, not upload, for an accepted row whose pending projection is absent", async () => {
    const test = fixture();
    await new LivePumpSession(test.options).submitPart(test.input);
    const state = readLivePumpState(test.statePath)!;
    delete state.pending;
    writeLivePumpState(test.statePath, state);
    const resumed = new LivePumpSession(test.options);
    expect((await resumed.resubmitUnconfirmedPart()).ok).toBe(false);
    expect(readLivePumpState(test.statePath)!.pending?.submissionState).toBe("accepted");
    test.show();
    expect((await resumed.recover()).ok).toBe(true);
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
