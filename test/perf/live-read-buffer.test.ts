import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { PartSink } from "../../packages/zero-upload/src/live-pump-part-sink.js";
import { setSpawnForTest } from "../../packages/zero-upload/src/live-pump-process.js";
import { runStream } from "../../packages/zero-upload/src/live-pump-stream.js";
import { TsCutter } from "../../packages/zero-upload/src/ts-cutter.js";
import { stream } from "../../packages/zero-upload/src/ts-fixture.js";

afterEach(() => { setSpawnForTest(undefined); vi.restoreAllMocks(); });

function installSource(chunks: Buffer[]) {
  const stdout = Readable.from(chunks);
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdout, stderr: null, kill: vi.fn(() => events.emit("close", null, "SIGKILL")),
  });
  stdout.once("end", () => child.emit("close", 0, null));
  setSpawnForTest(() => child);
  return child;
}

const noBoundary = () => { throw new Error("unexpected part boundary"); };

it("reuses stdout Buffer views without copying or leaking adjacent bytes (#353)", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-buffer-"));
  const expected = stream({ gops: 2 });
  const backing = Buffer.alloc(expected.length + 41, 0xee);
  expected.copy(backing, 17);
  const input = backing.subarray(17, 17 + expected.length);
  installSource([input]);
  const push = vi.spyOn(TsCutter.prototype, "push");
  const sink = new PartSink({ sizeCap: expected.length * 4, spoolPath: join(root, "part.ts") });
  try {
    const result = await runStream({
      args: [], sizeCap: expected.length * 4, firstSink: sink, stallTimeoutMs: 0,
      openNext: noBoundary, onPartSealed: noBoundary,
    });
    await sink.finished;
    expect(result.exit.code).toBe(0);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![0]).toBe(input);
    expect(readFileSync(sink.spoolPath)).toEqual(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("flushes exactly the consumed prefix, including an unaligned tail, on abort (#353)", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-abort-"));
  const input = stream({ gops: 2 });
  const prefix = input.subarray(0, input.length - 7);
  const child = installSource([prefix, input.subarray(prefix.length)]);
  const controller = new AbortController();
  const sink = new PartSink({ sizeCap: input.length * 4, spoolPath: join(root, "part.ts") });
  const write = sink.write.bind(sink);
  vi.spyOn(sink, "write").mockImplementationOnce((bytes) => { write(bytes); controller.abort(); });
  try {
    const result = await runStream({
      args: [], sizeCap: input.length * 4, firstSink: sink, stallTimeoutMs: 0,
      signal: controller.signal, openNext: noBoundary, onPartSealed: noBoundary,
    });
    await sink.finished;
    expect(result.endedBy).toBe("abort");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(readFileSync(sink.spoolPath)).toEqual(prefix);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves every input byte in the spool after bounded-transfer backpressure (#353)", async () => {
  const root = mkdtempSync(join(tmpdir(), "read-backpressure-"));
  const input = stream({ gops: 2 });
  installSource([input]);
  const onBackpressure = vi.fn();
  const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ upload_id: "fixture" })));
  const sink = new PartSink({
    sizeCap: input.length * 4, spoolPath: join(root, "part.ts"), queueCapacity: 1,
    session: {
      bucket: { chunkSize: 1024, auth: "fixture", endpoint: "//example.invalid", bizId: "1", uposUri: "upos://fixture" },
      url: "https://example.invalid/fixture", fileName: "fixture.ts",
    },
    fetchImpl: fakeFetch, onBackpressure,
  });
  try {
    await runStream({
      args: [], sizeCap: input.length * 4, firstSink: sink, stallTimeoutMs: 0,
      openNext: noBoundary, onPartSealed: noBoundary,
    });
    const result = await sink.finished;
    expect(onBackpressure).toHaveBeenCalledTimes(1);
    expect(result.backpressured).toBe(true);
    expect(result.spoolIncomplete).toBe(false);
    expect(readFileSync(sink.spoolPath)).toEqual(input);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
