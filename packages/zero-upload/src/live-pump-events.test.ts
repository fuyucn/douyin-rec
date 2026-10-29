import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  LivePumpSession,
  livePumpStatePath,
  readLivePumpState,
  runLivePump,
  setSpawnForTest,
  writeLivePumpState,
  type ChildProcessLike,
  type SpawnFn,
} from "./live-pump.js";
import type { LiveEvent, LivePumpReporter } from "@drec/core";

const CHUNK = 64 * 1024;

function fakeFfmpeg(bytes: number): void {
  setSpawnForTest((() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events: Record<string, Array<(...a: unknown[]) => void>> = {};
    const proc: ChildProcessLike = {
      stdout,
      stderr,
      on(ev, fn) { (events[ev] ??= []).push(fn); },
      kill() { stdout.end(); setTimeout(() => (events.close ?? []).forEach((f) => f(0, null)), 1); },
    };
    (async () => {
      for (let sent = 0; sent < bytes; sent += CHUNK) {
        stdout.write(Buffer.alloc(Math.min(CHUNK, bytes - sent), 0x5a));
        await new Promise((r) => setTimeout(r, 1));
      }
      stdout.end();
      await new Promise((r) => setTimeout(r, 5));
      (events.close ?? []).forEach((f) => f(0, null));
    })();
    return proc;
  }) as SpawnFn);
}

function fakeUpos(): typeof fetch {
  const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
  return ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const m = (init?.method ?? "GET").toUpperCase();
    if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
    if (m === "POST" && u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
    if (m === "PUT") return Promise.resolve(new Response("", { status: 200 }));
    if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
    if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
    if (u.pathname === "/x/vu/web/edit") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
    if (u.pathname === "/x/vupre/web/archive/view") return Promise.resolve(json({ code: 0, data: { archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21 }, videos: [] } }));
    if (u.pathname === "/x/web/archives") return Promise.resolve(json({ code: 0, data: { arc_audits: [] } }));
    return Promise.resolve(json({ code: 0, data: {} }));
  }) as unknown as typeof fetch;
}

describe("live-pump reporter events", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "live-pump-events-"));
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
  });
  afterEach(() => { setSpawnForTest(undefined); rmSync(dir, { recursive: true, force: true }); });

  it("emits waiting/run_start/live/part_streaming/progress/sealed/submit/confirmed", async () => {
    const events: LiveEvent[] = [];
    const progress: Array<{ part: number; uploadedBytes: number; chunks: number }> = [];
    const reporter: LivePumpReporter = {
      event: (e) => events.push(e),
      progress: (p) => progress.push(p),
    };
    fakeFfmpeg(CHUNK * 2);
    const r = await runLivePump({
      cookiesPath: join(dir, "cookies.json"), room: "evt", spoolDir: dir, title: "evt",
      tid: 21, tag: "x", private: true, sizeCap: CHUNK * 2, maxMs: 10_000, maxSegments: 1,
      quality: "origin", submit: true, spoolMode: "none", fetchImpl: fakeUpos(), reporter,
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      sleep: async () => {},
    });
    expect(r.ok, r.error ?? "").toBe(true);
    const kinds = events.map((e) => e.kind);
    for (const k of ["waiting", "run_start", "live", "part_streaming", "part_sealed", "part_submit", "part_confirmed"]) {
      expect(kinds, k).toContain(k);
    }
    expect(kinds.indexOf("part_streaming")).toBeLessThan(kinds.indexOf("part_sealed"));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.part === 0)).toBe(true);
    expect(events.find((e) => e.kind === "run_start")?.session?.sessionId).toContain("evt:");
  }, 20_000);

  it("a throwing reporter never changes the upload result", async () => {
    fakeFfmpeg(CHUNK * 2);
    const reporter: LivePumpReporter = {
      event: () => { throw new Error("event boom"); },
      progress: () => { throw new Error("progress boom"); },
    };
    const r = await runLivePump({
      cookiesPath: join(dir, "cookies.json"), room: "boom", spoolDir: dir, title: "boom",
      tid: 21, tag: "x", private: true, sizeCap: CHUNK * 2, maxMs: 10_000, maxSegments: 1,
      quality: "origin", submit: true, spoolMode: "none", fetchImpl: fakeUpos(), reporter,
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      sleep: async () => {},
    });
    expect(r.ok, r.error ?? "").toBe(true);
  }, 20_000);

  it("sessionInfo reports resumed for a loaded archive", () => {
    const state = {
      schemaVersion: 1 as const, room: "resume", createdAt: 100, title: "t", tid: 21, tag: "x",
      private: true, parts: [], updatedAt: 100,
    };
    writeLivePumpState(livePumpStatePath(dir, "resume"), state);
    expect(readLivePumpState(livePumpStatePath(dir, "resume"))?.createdAt).toBe(100);
    const s = new LivePumpSession({
      cookiesPath: join(dir, "cookies.json"), room: "resume", spoolDir: dir,
      title: "t", tid: 21, tag: "x", private: true,
    });
    expect(s.sessionInfo).toMatchObject({ sessionId: "resume:100", createdAt: 100, resumed: true });
  });
});
