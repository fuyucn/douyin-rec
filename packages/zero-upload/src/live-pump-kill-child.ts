// Child entry (bundled by the issue #581 reproduction test in live-pump.test.ts) and run as a
// REAL process that the test kills with SIGKILL mid-part.
//
// This is the only faithful way to reproduce the bug: SIGKILL / OOM / power loss / an uncaught
// `process.exit(1)` bypass every JS handler, so the current part is NEVER sealed and `noteSealed`
// never runs. An in-process `AbortSignal` cannot stand in for it — a stop always seals the part
// and writes the WAL, which is exactly the graceful path that does NOT lose data (review F2).
//
// The fake ffmpeg pushes a valid mpegts stream then holds stdout open (no EOF, no cut), so the
// part stays "currently recording" and the process sits in the pull loop until the test kills it.
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  runLivePump,
  setSpawnForTest,
  type ChildProcessLike,
  type SpawnFn,
} from "./live-pump.js";
import { stream as tsStream } from "./ts-fixture.js";

const dir = process.env.PUMP_DIR!;
const cookies = join(dir, "cookies.json");
writeFileSync(cookies, JSON.stringify({
  cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
}));

// Several GOPs: a later recovery must be able to read a positive PTS duration from the spool.
const data = tsStream({ gops: 6 });

setSpawnForTest((() => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = {} as Record<string, Array<(...a: unknown[]) => void>>;
  const proc: ChildProcessLike = {
    stdout,
    stderr,
    on(ev, fn) { (events[ev] ??= []).push(fn); },
    kill(sig) { stdout.end(); for (const f of events.close ?? []) f(null, sig ?? "SIGKILL"); },
  };
  // Push everything, then deliberately DO NOT end stdout: hold the current part open forever.
  (async (): Promise<void> => {
    for (let i = 0; i < data.length; i += 512) stdout.write(data.subarray(i, i + 512));
  })();
  return proc;
}) as SpawnFn);

// Minimal UPOS fake: preupload must resolve so openPart() runs. The spool bytes are written
// synchronously by PartSink.write regardless of whether the upload itself succeeds.
const upos = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const m = (init?.method ?? "GET").toUpperCase();
  if (u.pathname.endsWith("/preupload")) {
    return new Response(JSON.stringify({ OK: 1, chunk_size: 1024, auth: "a", endpoint: "//upos.test", biz_id: "1", upos_uri: "upos://b/x.ts" }), { status: 200 });
  }
  if (m === "POST" && u.searchParams.has("uploads")) return new Response(JSON.stringify({ upload_id: "u" }), { status: 200 });
  if (m === "PUT") return new Response("", { status: 200 });
  return new Response(JSON.stringify({ OK: 1, key: "b/x.ts" }), { status: 200 });
}) as unknown as typeof fetch;

// A parked async iterator alone does not hold the event loop open; keep the process alive so the
// test (not Node) decides when it dies.
setInterval(() => {}, 1000);

void runLivePump({
  cookiesPath: cookies, room: "sm", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
  sizeCap: 1 << 30, maxMs: 0, stallTimeoutMs: 0, queueCapacity: 64,
  quality: "origin", submit: true, spoolMode: "full",
  fetch: async () => ({ living: true, url: "http://x/y.ts" }),
  fetchImpl: upos, sleep: async () => {},
  probeDuration: async () => 60, scanDtsGap: async () => null,
  log: () => {},
});

// Signal READY only once the current part has real bytes on disk, so the SIGKILL lands mid-part
// (after openPart wrote whatever it writes, before any seal).
const poll = setInterval(() => {
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".live.ts") && statSync(join(dir, f)).size > 0) {
        clearInterval(poll);
        process.stdout.write("READY\n");
        return;
      }
    }
  } catch { /* spool not created yet */ }
}, 5);

export {};
