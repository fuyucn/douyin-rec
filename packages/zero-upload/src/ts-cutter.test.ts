import { describe, it, expect } from "vitest";
import { TS_PACKET, TsCutter, type CutterEvent } from "./ts-cutter.js";
import { AUDIO, VIDEO, pat, pmt, packet, pes, stream } from "./ts-fixture.js";


/** Run a stream through the cutter in arbitrary slices; return parts as byte arrays. */
function cutAll(c: TsCutter, input: Buffer, slice: number, cutAtBytes: number[] = []): { parts: Buffer[]; events: CutterEvent[] } {
  const events: CutterEvent[] = [];
  const parts: Buffer[][] = [[]];
  // Chunk boundaries = every `slice` bytes plus every requested cut offset, so a cut request is
  // always issued exactly when the stream reaches its offset, whatever the slice size.
  const bounds = new Set<number>([0, ...cutAtBytes.filter((b) => b < input.length)]);
  for (let at = 0; at < input.length; at += slice) bounds.add(at);
  const starts = [...bounds].sort((a, b) => a - b);
  const pending = [...cutAtBytes].sort((a, b) => a - b);
  for (let k = 0; k < starts.length; k++) {
    const at = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : input.length;
    while (pending.length && at >= pending[0]) {
      pending.shift();
      c.requestCut();
    }
    for (const e of c.push(input.subarray(at, end))) {
      events.push(e);
      if (e.kind === "cut") parts.push([]);
      else parts[parts.length - 1].push(e.bytes);
    }
  }
  for (const e of c.flush()) {
    events.push(e);
    if (e.kind === "data") parts[parts.length - 1].push(e.bytes);
  }
  return { parts: parts.map((p) => Buffer.concat(p)), events };
}

const head = (): Buffer => Buffer.concat([pat(), pmt([[0x1b, VIDEO], [0x0f, AUDIO]])]);
const stripHead = (p: Buffer, i: number): Buffer => (i === 0 ? p : p.subarray(head().length));
const isKeyframeStart = (p: Buffer, o: number): boolean =>
  (((p[o + 1] & 0x1f) << 8) | p[o + 2]) === VIDEO && (p[o + 1] & 0x40) !== 0 && (p[o + 5] & 0x40) !== 0;

describe("TsCutter", () => {
  it("conserves every byte and cuts only right before a video keyframe, any slicing", () => {
    const input = stream({ gops: 6 });
    for (const slice of [1, 7, 188, 1000, input.length]) {
      const { parts } = cutAll(new TsCutter({ maxPartBytes: 1 << 30 }), input, slice, [3000, 9000]);
      expect(parts.length).toBe(3);
      expect(Buffer.concat(parts.map(stripHead))).toEqual(input);
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i].subarray(0, head().length)).toEqual(head());
        expect(isKeyframeStart(parts[i], head().length)).toBe(true);
      }
    }
  });

  it("a cut requested mid-GOP waits for the next keyframe, not the next packet", () => {
    const input = stream({ gops: 3 });
    const { parts } = cutAll(new TsCutter({ maxPartBytes: 1 << 30 }), input, TS_PACKET, [TS_PACKET * 5]);
    // PAT + PMT + one full GOP of 4 frames × (3 video + 1 audio) packets.
    expect(parts[0].length).toBe(TS_PACKET * (2 + 16));
  });

  it("before the PMT is known no cut happens; data stays in the first part", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    c.requestCut();
    const ev = c.push(Buffer.concat([packet(VIDEO, { pusi: true, rai: true, payload: pes(0) })]));
    expect(ev.every((e) => e.kind === "data")).toBe(true);
  });

  it("size: asks for a keyframe cut inside the margin and never exceeds maxPartBytes", () => {
    const input = stream({ gops: 20 });
    const max = TS_PACKET * 40;
    const { parts, events } = cutAll(new TsCutter({ maxPartBytes: max, minMarginBytes: TS_PACKET * 20 }), input, 500);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(max);
    expect(events.filter((e) => e.kind === "cut").every((e) => e.kind === "cut" && !e.forced)).toBe(true);
    expect(Buffer.concat(parts.map(stripHead))).toEqual(input);
  });

  it("size: no keyframe before the hard bound → forced cut at a packet boundary, bytes kept", () => {
    const input = stream({ gops: 1, framesPerGop: 60 }); // one keyframe only
    const max = TS_PACKET * 50;
    const { parts, events } = cutAll(new TsCutter({ maxPartBytes: max, minMarginBytes: TS_PACKET * 10 }), input, 300);
    expect(events.some((e) => e.kind === "cut" && e.forced)).toBe(true);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(max);
      expect(p.length % TS_PACKET).toBe(0);
    }
    expect(Buffer.concat(parts.map(stripHead))).toEqual(input);
  });

  it("audio-only stream cuts at the audio PES start", () => {
    const input = stream({ gops: 4, video: false });
    const audioHead = Buffer.concat([pat(), pmt([[0x0f, AUDIO]])]);
    const { parts } = cutAll(new TsCutter({ maxPartBytes: 1 << 30 }), input, 188, [TS_PACKET * 6]);
    expect(parts.length).toBe(2);
    expect(parts[1].subarray(0, audioHead.length)).toEqual(audioHead);
    expect(Buffer.concat([parts[0], parts[1].subarray(audioHead.length)])).toEqual(input);
  });

  it("timing: per-part duration from video PTS, wrap-safe", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    c.push(stream({ gops: 2, startPts: 2 ** 33 - 6000 })); // crosses the 33-bit wrap
    const t = c.currentTiming()!;
    expect(t.durationSec).toBeCloseTo((8 - 1) * 3000 / 90_000, 6);
  });

  it("timing resets at a cut: each part measures only its own frames", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    const input = stream({ gops: 4 });
    const half = TS_PACKET * (2 + 16 * 2);
    c.push(input.subarray(0, half));
    c.requestCut();
    const ev = c.push(input.subarray(half, half + TS_PACKET));
    expect(ev.some((e) => e.kind === "cut")).toBe(true);
    c.push(input.subarray(half + TS_PACKET));
    expect(c.currentTiming()!.durationSec).toBeCloseTo(7 * 3000 / 90_000, 6);
  });

  it("an unaligned tail at end of stream is emitted by flush, never dropped", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    const input = Buffer.concat([stream({ gops: 1 }), Buffer.from([0x47, 1, 2])]);
    const bytes = [...c.push(input), ...c.flush()].filter((e) => e.kind === "data").map((e) => (e as { bytes: Buffer }).bytes);
    expect(Buffer.concat(bytes)).toEqual(input);
  });

  it("cut event reports the finished part's size and PTS timing", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    const input = stream({ gops: 4 });
    const half = TS_PACKET * (2 + 16 * 2);
    c.push(input.subarray(0, half));
    c.requestCut();
    const cut = c.push(input.subarray(half)).find((e) => e.kind === "cut");
    expect(cut).toMatchObject({ kind: "cut", reason: "requested", forced: false, partBytes: half });
    expect(cut?.kind === "cut" && cut.timing?.durationSec).toBeCloseTo(7 * 3000 / 90_000, 6);
  });

  it("a cap smaller than the default margin still yields multi-GOP parts", () => {
    const input = stream({ gops: 12 });
    const gop = TS_PACKET * 16;
    const { parts } = cutAll(new TsCutter({ maxPartBytes: gop * 5 }), input, 1000);
    expect(parts.length).toBeLessThan(12);
    expect(Buffer.concat(parts.map(stripHead))).toEqual(input);
  });

  it("a long unsynced run never exceeds the hard bound", () => {
    const max = TS_PACKET * 8;
    const c = new TsCutter({ maxPartBytes: max });
    const input = Buffer.concat([Buffer.alloc(max * 3 + 17, 1), stream({ gops: 1 })]);
    const parts: Buffer[][] = [[]];
    for (const e of [...c.push(input), ...c.flush()]) {
      if (e.kind === "cut") parts.push([]);
      else parts[parts.length - 1].push(e.bytes);
    }
    for (const p of parts) expect(Buffer.concat(p).length).toBeLessThanOrEqual(max);
  });

  it("out-of-sync bytes are passed through unchanged", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    const input = Buffer.concat([Buffer.from([1, 2, 3, 4, 5]), stream({ gops: 2 })]);
    const bytes = [...c.push(input), ...c.flush()].filter((e) => e.kind === "data").map((e) => (e as { bytes: Buffer }).bytes);
    expect(Buffer.concat(bytes)).toEqual(input);
  });

  it("a cut requested on a part with no media yet is deferred, never an empty part", () => {
    const c = new TsCutter({ maxPartBytes: 1 << 30 });
    c.requestCut();
    const ev = c.push(stream({ gops: 3 }));
    // PAT/PMT then the very first keyframe: nothing to cut yet; the cut lands on the second GOP.
    const cuts = ev.filter((e) => e.kind === "cut");
    expect(cuts.length).toBe(1);
    expect(cuts[0].kind === "cut" && cuts[0].partBytes).toBe(TS_PACKET * (2 + 16));
  });

  it("flush never lets a trailing partial packet push a part over the hard bound", () => {
    const max = TS_PACKET * 6;
    const c = new TsCutter({ maxPartBytes: max, minMarginBytes: TS_PACKET });
    // Exactly `max` bytes of whole packets, then a partial packet left in the carry.
    const full = Buffer.concat([stream({ gops: 1, framesPerGop: 2, pkts: 1 }).subarray(0, max), Buffer.from([0x47, 1, 2, 3])]);
    const events = [...c.push(full), ...c.flush()];
    expect(events.some((e) => e.kind === "cut" && e.forced)).toBe(true);
    const parts: Buffer[][] = [[]];
    for (const e of events) {
      if (e.kind === "cut") parts.push([]);
      else parts[parts.length - 1].push(e.bytes);
    }
    for (const p of parts) expect(Buffer.concat(p).length).toBeLessThanOrEqual(max);
  });

  it("maxDurationMs cuts at the first keyframe after the PTS span is reached, whatever the slicing", () => {
    const input = stream({ gops: 6 }); // one GOP = 4 frames = 133ms
    for (const slice of [1, 188, 4096, input.length]) {
      const { parts, events } = cutAll(new TsCutter({ maxPartBytes: 1 << 30, maxDurationMs: 300 }), input, slice);
      const cuts = events.filter((e) => e.kind === "cut");
      // 300ms is reached inside the 3rd GOP; the cut waits for the 4th keyframe (12 frames = 400ms).
      expect(cuts[0]).toMatchObject({ reason: "duration", forced: false });
      expect(cuts[0]?.kind === "cut" && cuts[0].timing?.durationSec).toBeCloseTo((12 - 1) * 3000 / 90_000, 6);
      for (let i = 1; i < parts.length; i++) expect(isKeyframeStart(parts[i], head().length)).toBe(true);
      expect(Buffer.concat(parts.map(stripHead))).toEqual(input);
    }
  });
});
