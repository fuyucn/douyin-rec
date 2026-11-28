import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePumpSession } from "./live-pump-session.js";
import * as stateStore from "./live-pump-state.js";
import * as recovery from "./live-pump-spool-recovery.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "live-recovery-proof-"));
  roots.push(root);
  const cookiesPath = join(root, "cookies.json");
  writeFileSync(cookiesPath, JSON.stringify({ cookie_info: { cookies: [{ name: "bili_jct", value: "test" }] } }));
  const spoolPath = join(root, "part.ts");
  writeFileSync(spoolPath, "data");
  const statePath = stateStore.livePumpStatePath(root, "test-room");
  const writes = vi.fn();
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes(stateStore.readLivePumpState(statePath));
      return Response.json({ code: 0, data: { aid: 7, bvid: "test-archive" } });
    }
    return Response.json({ code: 0, data: {
      archive: { aid: 7, bvid: "test-archive", title: "test", tid: 21 },
      videos: [{ filename: "native-part" }],
    } });
  }) as unknown as typeof fetch;
  const session = new LivePumpSession({
    room: "test-room", spoolDir: root, cookiesPath, title: "test", tid: 21, tag: "test",
    fetchImpl, log: () => {},
  });
  expect(session.noteUnconfirmedPart({
    index: 0, spoolPath, title: "P1", bytes: 0, durationSec: 0, sealed: false,
  })).toEqual({ ok: true });
  const ready = { kind: "ready" as const, stem: "native-part", bytes: 4, durationSec: 1 };
  return { session, statePath, spoolPath, writes, ready };
}

describe("recovered spool publication proof", () => {
  it("persists an adopted spool as sealed before metadata publication and proof-gated cleanup", async () => {
    const test = fixture();
    vi.spyOn(recovery, "prepareRecoveredSpool").mockResolvedValue(test.ready);
    await expect(test.session.resubmitUnconfirmedPart()).resolves.toMatchObject({ ok: true });
    expect(test.writes).toHaveBeenCalledTimes(1);
    const publication = test.writes.mock.calls[0]![0];
    expect(publication.parts[0].sealed).toBe(true);
    expect(publication.parts[0]).toMatchObject({ bytes: 4, durationSec: 1, stem: "native-part" });
    expect(publication.pending.sourceFp).toMatchObject({ size: 4 });
    expect(stateStore.readLivePumpState(test.statePath)?.parts[0]).toMatchObject({
      confirmed: true, proof: "observed", nativeKey: "native-part",
    });
    expect(existsSync(test.spoolPath)).toBe(false);
  });

  it("retains the original open checkpoint and source if sealing cannot persist", async () => {
    const test = fixture();
    const original = readFileSync(test.statePath, "utf8");
    vi.spyOn(recovery, "prepareRecoveredSpool").mockImplementation(async () => {
      vi.spyOn(stateStore, "writeLivePumpState").mockImplementationOnce(() => { throw new Error("checkpoint unavailable"); });
      return test.ready;
    });
    await expect(test.session.resubmitUnconfirmedPart()).resolves.toMatchObject({
      ok: false, error: expect.stringContaining("cannot persist unconfirmed part"),
    });
    expect(readFileSync(test.statePath, "utf8")).toBe(original);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).not.toHaveBeenCalled();
  });

  it("does not promote an open spool when recovery validation or transfer fails", async () => {
    const test = fixture();
    vi.spyOn(recovery, "prepareRecoveredSpool").mockResolvedValue({ kind: "failed", error: "source unreadable" });
    await expect(test.session.resubmitUnconfirmedPart()).resolves.toMatchObject({ ok: false, error: "source unreadable" });
    expect(stateStore.readLivePumpState(test.statePath)?.parts[0]?.sealed).toBe(false);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).not.toHaveBeenCalled();
  });

  it("does not seal or submit when stopped during recovery", async () => {
    const test = fixture();
    const controller = new AbortController();
    vi.spyOn(recovery, "prepareRecoveredSpool").mockImplementation(async () => {
      controller.abort();
      return test.ready;
    });
    await expect(test.session.resubmitUnconfirmedPart(controller.signal)).resolves.toMatchObject({ ok: false, error: "resubmit aborted" });
    expect(stateStore.readLivePumpState(test.statePath)?.parts[0]?.sealed).toBe(false);
    expect(readFileSync(test.spoolPath, "utf8")).toBe("data");
    expect(test.writes).not.toHaveBeenCalled();
  });
});
