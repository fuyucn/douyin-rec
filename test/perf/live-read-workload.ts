import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import type { PartSink } from "../../packages/zero-upload/src/live-pump-part-sink.js";
import { setSpawnForTest } from "../../packages/zero-upload/src/live-pump-process.js";
import { runStream } from "../../packages/zero-upload/src/live-pump-stream.js";
import { TsCutter } from "../../packages/zero-upload/src/ts-cutter.js";
import { stream } from "../../packages/zero-upload/src/ts-fixture.js";

const input = stream({ gops: 256 });
const chunks: Buffer[] = [];
for (let i = 0; i < input.length; i += 64 * 1024) chunks.push(input.subarray(i, i + 64 * 1024));
const views = new Set(chunks);

async function replay(mib: number) {
  const repeats = Math.ceil(mib * 1024 * 1024 / input.length);
  const hash = createHash("sha256");
  let bytes = 0;
  let reusedReads = 0;
  let copiedReads = 0;
  const originalPush = TsCutter.prototype.push;
  TsCutter.prototype.push = function (data: Buffer) {
    if (views.has(data)) reusedReads++;
    else copiedReads++;
    return originalPush.call(this, data);
  };
  const stdout = Readable.from((function* () {
    for (let i = 0; i < repeats; i++) yield* chunks;
  })());
  const child = Object.assign(new EventEmitter(), { stdout, stderr: null, kill() {} });
  stdout.once("end", () => child.emit("close", 0, null));
  setSpawnForTest(() => child);
  // Count and hash output, without disk, network or a real recording process.
  const sink = {
    write(data: Buffer) { bytes += data.length; hash.update(data); },
    seal() {}, fail(reason: string) { throw new Error(reason); },
    discard() { throw new Error("unexpected discarded part"); },
  } as unknown as PartSink;
  const started = performance.now();
  const cpu = process.cpuUsage();
  try {
    const result = await runStream({
      args: [], firstSink: sink, sizeCap: Number.MAX_SAFE_INTEGER, stallTimeoutMs: 0,
      openNext: () => { throw new Error("unexpected part boundary"); },
      onPartSealed: () => { throw new Error("unexpected part boundary"); },
    });
    const usage = process.cpuUsage(cpu);
    if (result.exit.code !== 0 || bytes !== input.length * repeats) throw new Error("byte conservation failed");
    return {
      bytes, sha256: hash.digest("hex"), reusedReads, copiedReads,
      cpuMs: (usage.user + usage.system) / 1000, wallMs: performance.now() - started,
    };
  } finally {
    setSpawnForTest(undefined);
    TsCutter.prototype.push = originalPush;
  }
}

const mib = Number(process.argv[2]);
if (!Number.isSafeInteger(mib) || mib < 1 || mib > 4096) throw new Error("MiB must be an integer from 1 to 4096");
await replay(64);
console.log(JSON.stringify(await replay(mib)));
