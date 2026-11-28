import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePumpSession, livePumpStatePath, readLivePumpState, writeLivePumpState } from "@drec/zero-upload";
import { buildLivePumpSubmitter } from "./live-pump-submitter.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pump-aid-recovery-")); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function legacySession(fetchImpl: typeof fetch, pending = false, observed = false) {
  const cookiesPath = join(dir, "cookies.json");
  writeFileSync(cookiesPath, JSON.stringify({ cookie_info: { cookies: [
    { name: "SESSDATA", value: "test-session" }, { name: "bili_jct", value: "test-csrf" },
  ] } }));
  const statePath = livePumpStatePath(dir, "test-room");
  const input = { index: 1, spoolPath: join(dir, "p2.ts"), stem: "stem1",
    title: "P2", bytes: 7, durationSec: 180 };
  writeFileSync(input.spoolPath, "part-2!");
  writeLivePumpState(statePath, {
    schemaVersion: 1, room: "test-room", createdAt: Date.now(), updatedAt: Date.now(),
    title: "T", tid: 21, tag: "", private: true, aid: 7,
    parts: [
      { ...input, index: 0, stem: "stem0", title: "P1", spoolPath: join(dir, "gone.ts"),
        filename: "gone.ts", confirmed: true,
        ...(observed ? { proof: "observed" as const, nativeKey: "stem0", observedAt: Date.now() } : {}) },
      { ...input, filename: "p2.ts", confirmed: false },
    ],
    ...(pending ? { pending: { ...input, partIndex: 1, kind: "append" as const } } : {}),
  });
  vi.stubGlobal("fetch", fetchImpl);
  const submitter = buildLivePumpSubmitter({ cookiesPath, spoolDir: dir, pumpRoom: "test-room" });
  const append = vi.spyOn(submitter, "appendStreamedPart");
  const session = new LivePumpSession({
    cookiesPath, spoolDir: dir, room: "test-room", title: "T", tid: 21, tag: "",
    fetchImpl, submitter, log: () => {},
  });
  return { session, input, statePath, append };
}

function archiveResponse(aid = 7, bvid: string | undefined = "BILIfake1", appended = false) {
  return Response.json({ code: 0, data: {
    archive: { aid, bvid, title: "T", tid: 21, is_only_self: 1 },
    videos: [{ cid: 1, filename: "stem0", title: "P1" },
      ...(appended ? [{ cid: 2, filename: "stem1", title: "P2" }] : [])],
  } });
}

describe("default live-pump driver legacy identity recovery", () => {
  it("resolves aid-only state before appending P2 with the original checkpoint", async () => {
    const hits: string[] = [];
    const posts: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      hits.push(url.pathname + (url.pathname.endsWith("/view") ? url.search : ""));
      if (url.pathname === "/x/vu/web/edit") {
        posts.push(JSON.parse(String(init?.body)));
        return Response.json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } });
      }
      if (url.search === "?aid=7" || url.search === "?bvid=BILIfake1") return archiveResponse(7, "BILIfake1", posts.length > 0);
      return Response.json({ code: -404 });
    };
    const { session, input, statePath, append } = legacySession(fetchImpl, false, true);
    await expect(session.recover()).resolves.toEqual({ ok: true });
    await expect(session.submitPart(input)).resolves.toMatchObject({ ok: true, bvid: "BILIfake1", aid: 7 });
    expect(append).toHaveBeenCalledOnce();
    await expect(append.mock.results[0]!.value).resolves.toEqual({ confirmed: [2], accepted: [] });
    expect(hits).toEqual([
      "/x/vupre/web/archive/view?aid=7",
      "/x/vupre/web/archive/view?bvid=BILIfake1",
      "/x/vu/web/edit",
      "/x/vupre/web/archive/view?bvid=BILIfake1",
    ]);
    expect(posts).toEqual([expect.objectContaining({ aid: 7, is_only_self: 1,
      watermark: { state: 0 }, videos: [
        expect.objectContaining({ filename: "stem0" }), expect.objectContaining({ filename: "stem1" }),
      ] })]);
    expect(readLivePumpState(statePath)).toMatchObject({ aid: 7, bvid: "BILIfake1",
      parts: [{ index: 0, confirmed: true }, { index: 1, confirmed: true }] });
    expect(existsSync(input.spoolPath)).toBe(false);
  });

  it("holds unproved historical confirmations without another metadata submission", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => archiveResponse());
    const { session, input, statePath, append } = legacySession(fetchImpl);
    const before = readFileSync(statePath, "utf8");
    await expect(session.recover()).resolves.toMatchObject({ ok: false, needsManual: true });
    expect(append).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(existsSync(input.spoolPath)).toBe(true);
  });

  it.each([
    ["different aid", () => archiveResponse(8), ["/x/vupre/web/archive/view?aid=7"]],
    ["missing bvid", () => archiveResponse(7, ""), ["/x/vupre/web/archive/view?aid=7"]],
    ["unreadable archive", () => Response.json({ code: -404 }),
      ["/x/vupre/web/archive/view?aid=7", "/x/client/archive/view?aid=7"]],
  ] as const)("preserves state and spool on %s without submitting", async (_name, response, expectedReads) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const { session, input, statePath, append } = legacySession(fetchImpl, false, true);
    const before = readFileSync(statePath, "utf8");
    await expect(session.submitPart(input)).resolves.toMatchObject({ ok: false, needsManual: true });
    expect(append).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(input.spoolPath, "utf8")).toBe("part-2!");
    expect(fetchImpl.mock.calls.map(([input]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname + url.search;
    })).toEqual(expectedReads);
    expect(fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("rejects a mismatched pending-append identity before reconciling its stem", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ code: 0, data: {
      archive: { aid: 8, bvid: "BILIother", title: "T", tid: 21 },
      videos: [{ cid: 1, filename: "stem1", title: "P2" }],
    } });
    const { session, input, statePath, append } = legacySession(fetchImpl, true);
    const before = readFileSync(statePath, "utf8");
    await expect(session.recover()).resolves.toMatchObject({ ok: false, needsManual: true });
    expect(append).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(input.spoolPath, "utf8")).toBe("part-2!");
  });

  it("refuses further submission when normalized identity cannot be persisted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => archiveResponse());
    const { session, input, statePath, append } = legacySession(fetchImpl, false, true);
    const before = readFileSync(statePath, "utf8");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    mkdirSync(`${statePath}.tmp.${process.pid}.${now.toString(36)}`);
    await expect(session.submitPart(input)).resolves.toMatchObject({ ok: false, needsManual: true });
    await expect(session.submitPart(input)).resolves.toMatchObject({ ok: false,
      error: expect.stringContaining("untrusted") });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(input.spoolPath, "utf8")).toBe("part-2!");
  });

  it("aborts an in-flight identity lookup without a fallback request or state write", async () => {
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      markStarted();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const { session, input, statePath, append } = legacySession(fetchImpl, false, true);
    const before = readFileSync(statePath, "utf8");
    const controller = new AbortController();
    const result = session.submitPart(input, controller.signal);
    await started;
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(readFileSync(statePath, "utf8")).toBe(before);
    expect(readFileSync(input.spoolPath, "utf8")).toBe("part-2!");
  }, 1_000);
});
