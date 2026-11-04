/**
 * ts-cutter.ts — split one continuous MPEG-TS byte stream into parts at video keyframes (plans/043).
 *
 * The live pump runs one ffmpeg per stream connection and lets this cutter decide where a part ends,
 * so switching parts never stops the pull (the old "one ffmpeg per part" design lost up to a minute
 * of broadcast at every switch, issue #452).
 *
 * Invariants:
 *   - Byte conservation: concatenating every emitted `data` chunk, minus the PAT/PMT head that is
 *     prepended to each new part, gives back exactly the input bytes.
 *   - A part never exceeds `maxPartBytes` (the size declared to UPOS before the bytes exist).
 *   - Cuts land on a 188-byte packet boundary, normally right before the packet that starts a video
 *     keyframe PES (PUSI + random_access_indicator), so every part starts decodable.
 *
 * Pure and synchronous: no I/O, no timers. The caller asks for a cut (duration reached) with
 * {@link TsCutter.requestCut}; size limits are handled here.
 */

export const TS_PACKET = 188;
const SYNC = 0x47;
const PTS_HZ = 90_000;
const PTS_WRAP = 2 ** 33;

export type CutReason = "requested" | "duration" | "size" | "forced";

export type CutterEvent =
  | { kind: "data"; bytes: Buffer }
  /**
   * The current part ends here. `forced`: no keyframe arrived before the size limit.
   * `partBytes` / `timing` describe the part that just ended (head included).
   */
  | { kind: "cut"; reason: CutReason; forced: boolean; partBytes: number; timing: PartTiming | null };

export interface TsCutterOptions {
  /** Hard upper bound for one part, in bytes (head included). */
  maxPartBytes: number;
  /**
   * Ask for a keyframe cut once this close to the hard bound. Default 16 MiB (raised to 2 GOPs).
   * Never more than half of `maxPartBytes`, so a small cap still yields multi-GOP parts.
   */
  minMarginBytes?: number;
  /**
   * Ask for a keyframe cut once the part's video PTS span reaches this many milliseconds. Evaluated
   * per packet, so it does not depend on how stdout happened to be sliced into reads.
   */
  maxDurationMs?: number;
  /**
   * A PTS step larger than this (either direction, milliseconds) is a timestamp jump, not media
   * time: it is ignored when measuring the part's duration. Default 10 s.
   */
  ptsJumpMs?: number;
  /** Called for every ignored PTS jump (seconds, as seen on the wire). */
  onPtsJump?: (info: { fromSec: number; toSec: number }) => void;
}

/** Media time covered by one part, from the primary stream's PTS (video, or first stream). */
export interface PartTiming {
  /** First video PTS of the part, in seconds (raw 90 kHz ticks stay internal). */
  firstPts: number;
  /** Last video PTS of the part, in seconds (raw 90 kHz ticks stay internal). */
  lastPts: number;
  /**
   * Media time covered, wrap-safe: the sum of forward PTS steps, with jumps ignored (see
   * {@link TsCutterOptions.ptsJumpMs}). 0 when fewer than two timestamps were seen.
   */
  durationSec: number;
  /** Total seconds of forward PTS jumps inside the part (media missing at resume points). */
  ptsJumpSec?: number;
  /** Number of forward PTS jumps inside the part. */
  ptsJumpCount?: number;
}

const pidOf = (p: Buffer, o: number): number => ((p[o + 1] & 0x1f) << 8) | p[o + 2];

/** Byte offset of the payload inside the packet at `o`, or -1 when the packet has none. */
function payloadOffset(p: Buffer, o: number): number {
  const afc = (p[o + 3] >> 4) & 3;
  if (!(afc & 1)) return -1;
  const start = afc & 2 ? o + 5 + p[o + 4] : o + 4;
  return start < o + TS_PACKET ? start : -1;
}

function isRandomAccess(p: Buffer, o: number): boolean {
  const afc = (p[o + 3] >> 4) & 3;
  return (afc & 2) !== 0 && p[o + 4] > 0 && (p[o + 5] & 0x40) !== 0;
}

/** PTS of a PES starting in this packet, or null. */
function pesPts(p: Buffer, o: number): number | null {
  const s = payloadOffset(p, o);
  const end = o + TS_PACKET;
  if (s < 0 || s + 14 > end) return null;
  if (p[s] !== 0 || p[s + 1] !== 0 || p[s + 2] !== 1) return null;
  if (((p[s + 7] >> 6) & 2) === 0) return null;
  const b = s + 9;
  return (
    ((p[b] >> 1) & 7) * 2 ** 30 +
    (p[b + 1] << 22) +
    ((p[b + 2] >> 1) << 15) +
    (p[b + 3] << 7) +
    (p[b + 4] >> 1)
  );
}

/** Start of the PSI section in this packet (after pointer_field), or -1. */
function sectionStart(p: Buffer, o: number): number {
  const s = payloadOffset(p, o);
  if (s < 0) return -1;
  const at = s + 1 + p[s];
  return at + 3 <= o + TS_PACKET ? at : -1;
}

export class TsCutter {
  private readonly maxPartBytes: number;
  private readonly minMarginBytes: number;
  private readonly maxDurationTicks: number;
  private readonly ptsJumpTicks: number;
  private readonly onPtsJump?: (info: { fromSec: number; toSec: number }) => void;
  private carry: Buffer = Buffer.alloc(0);
  private pmtPid = -1;
  private videoPid = -1;
  /** Video if present, otherwise the first elementary stream: drives cuts and timing. */
  private primaryPid = -1;
  private pat: Buffer | null = null;
  private pmt: Buffer | null = null;
  private partBytes = 0;
  /**
   * Bytes in the current part that came from ffmpeg and are not a PAT/PMT packet (including
   * unsynced pass-through and a trailing partial packet). A cut is pointless while this is 0, and
   * a part with 0 holds nothing but the head we prepended, so it may be dropped.
   */
  private mediaBytes = 0;
  private cutPending: CutReason | null = null;
  private lastKeyAt = -1;
  private maxGopBytes = 0;
  private streamBytes = 0;
  private timing: { first: number; last: number; prev: number; high: number; span: number } | null = null;
  private jumpSec = 0;
  private jumpCount = 0;

  constructor(o: TsCutterOptions) {
    if (!(o.maxPartBytes > TS_PACKET * 4)) throw new Error("TsCutter: maxPartBytes too small");
    this.maxPartBytes = o.maxPartBytes;
    this.minMarginBytes = o.minMarginBytes ?? 16 * 1024 * 1024;
    this.ptsJumpTicks = ((o.ptsJumpMs ?? 10_000) * PTS_HZ) / 1000;
    this.onPtsJump = o.onPtsJump;
    this.maxDurationTicks = o.maxDurationMs && o.maxDurationMs > 0 ? (o.maxDurationMs * PTS_HZ) / 1000 : 0;
  }

  /** Cut at the next keyframe (e.g. the part's duration is reached). Idempotent. */
  requestCut(): void {
    this.cutPending ??= "requested";
  }

  /** Bytes in the current part so far (head included). */
  get currentPartBytes(): number {
    return this.partBytes;
  }

  /** Bytes in the current part that are not PAT/PMT (0 = nothing worth uploading yet). */
  get currentMediaBytes(): number {
    return this.mediaBytes;
  }

  /** Part size at which a keyframe cut is requested (hard bound minus the margin). */
  get sizeTriggerBytes(): number {
    return this.softLimit();
  }

  /** Media timing of the current part so far. */
  currentTiming(): PartTiming | null {
    const t = this.timing;
    if (!t) return null;
    return {
      // Seconds everywhere: the only conversion point from the internal 90 kHz ticks, so
      // callers (per-part reports) cannot mix ticks into second-based logs.
      firstPts: t.first / PTS_HZ, lastPts: t.last / PTS_HZ, durationSec: t.span / PTS_HZ,
      ...(this.jumpSec > 0 ? { ptsJumpSec: this.jumpSec, ptsJumpCount: this.jumpCount } : {}),
    };
  }

  /** Feed stdout bytes; returns data and cut events in stream order. */
  push(buf: Buffer): CutterEvent[] {
    const out: CutterEvent[] = [];
    const data = this.carry.length ? Buffer.concat([this.carry, buf]) : buf;
    this.carry = Buffer.alloc(0);
    let runStart = 0;
    let i = 0;
    const flushRun = (to: number): void => {
      if (to > runStart) out.push({ kind: "data", bytes: Buffer.from(data.subarray(runStart, to)) });
      runStart = to;
    };
    while (i < data.length) {
      if (data[i] !== SYNC) {
        // Out of sync (should not happen with ffmpeg's muxer). Pass bytes through unchanged until
        // the next byte that starts two consecutive packets; never drop them.
        const next = this.findSync(data, i + 1);
        if (next < 0) {
          // Keep a tail that may hold the next sync, pass the rest through.
          const keep = Math.min(data.length - i, TS_PACKET * 2 - 1);
          const passTo = data.length - keep;
          this.passThrough(i, passTo, out, flushRun);
          i = passTo;
          break;
        }
        this.passThrough(i, next, out, flushRun);
        i = next;
        continue;
      }
      if (i + TS_PACKET > data.length) break;
      this.beforePacket(data, i, out, () => flushRun(i));
      this.inspect(data, i);
      const ipid = pidOf(data, i);
      if (ipid !== 0 && ipid !== this.pmtPid) this.mediaBytes += TS_PACKET;
      this.partBytes += TS_PACKET;
      this.streamBytes += TS_PACKET;
      i += TS_PACKET;
    }
    flushRun(i);
    if (i < data.length) this.carry = Buffer.from(data.subarray(i));
    return out;
  }

  /** End of stream: whatever partial packet is left belongs to the current part. */
  flush(): CutterEvent[] {
    if (!this.carry.length) return [];
    const bytes = this.carry;
    this.carry = Buffer.alloc(0);
    const out: CutterEvent[] = [];
    // A partial packet still counts against the declared size: never let the tail overflow it.
    if (this.partBytes + bytes.length > this.maxPartBytes) this.cut("size", true, out);
    this.partBytes += bytes.length;
    this.mediaBytes += bytes.length;
    this.streamBytes += bytes.length;
    out.push({ kind: "data", bytes });
    return out;
  }

  private findSync(d: Buffer, from: number): number {
    for (let j = from; j < d.length; j++) {
      if (d[j] !== SYNC) continue;
      if (j + TS_PACKET >= d.length || d[j + TS_PACKET] === SYNC) return j;
    }
    return -1;
  }

  /** Count unsynced bytes [from, to) into parts, force-cutting wherever the hard bound is hit. */
  private passThrough(from: number, to: number, out: CutterEvent[], flushRun: (to: number) => void): void {
    while (from < to) {
      const room = this.maxPartBytes - this.partBytes;
      if (room <= 0) {
        flushRun(from);
        this.cut(this.cutPending ?? "size", true, out);
        continue;
      }
      const take = Math.min(room, to - from);
      this.partBytes += take;
      this.mediaBytes += take; // bytes from ffmpeg, whatever they are: never droppable as "head only"
      this.streamBytes += take;
      from += take;
    }
  }

  private softLimit(): number {
    const margin = Math.min(Math.max(this.minMarginBytes, 2 * this.maxGopBytes), Math.floor(this.maxPartBytes / 2));
    return this.maxPartBytes - margin;
  }

  private beforePacket(d: Buffer, o: number, out: CutterEvent[], flush: () => void): void {
    const pid = pidOf(d, o);
    const pusi = (d[o + 1] & 0x40) !== 0;
    if (this.cutPending === null && this.partBytes >= this.softLimit()) this.cutPending = "size";
    // Hard bound: the declared size cannot be exceeded, keyframe or not.
    if (this.partBytes + TS_PACKET > this.maxPartBytes) {
      flush();
      this.cut(this.cutPending ?? "size", true, out);
      return;
    }
    if (this.cutPending === null || this.mediaBytes === 0 || pid !== this.primaryPid || !pusi) return;
    const keyframe = this.videoPid < 0 || isRandomAccess(d, o);
    if (!keyframe) return;
    flush();
    this.cut(this.cutPending, false, out);
  }

  private cut(reason: CutReason, forced: boolean, out: CutterEvent[]): void {
    out.push({ kind: "cut", reason, forced, partBytes: this.partBytes, timing: this.currentTiming() });
    this.cutPending = null;
    this.partBytes = 0;
    this.mediaBytes = 0;
    this.timing = null;
    this.jumpSec = 0;
    this.jumpCount = 0;
    const head = this.pat && this.pmt ? Buffer.concat([this.pat, this.pmt]) : null;
    if (head) {
      out.push({ kind: "data", bytes: head });
      this.partBytes = head.length;
    }
  }

  private inspect(d: Buffer, o: number): void {
    const pid = pidOf(d, o);
    const pusi = (d[o + 1] & 0x40) !== 0;
    if (pid === 0 && pusi) {
      this.pat = Buffer.from(d.subarray(o, o + TS_PACKET));
      this.parsePat(d, o);
      return;
    }
    if (pid === this.pmtPid && pusi) {
      this.pmt = Buffer.from(d.subarray(o, o + TS_PACKET));
      this.parsePmt(d, o);
      return;
    }
    if (pid !== this.primaryPid || !pusi) return;
    if (this.videoPid >= 0 && isRandomAccess(d, o)) {
      if (this.lastKeyAt >= 0) this.maxGopBytes = Math.max(this.maxGopBytes, this.streamBytes - this.lastKeyAt);
      this.lastKeyAt = this.streamBytes;
    }
    const pts = pesPts(d, o);
    if (pts === null) return;
    if (!this.timing) {
      this.timing = { first: pts, last: pts, prev: pts, high: pts, span: 0 };
      return;
    }
    // Unwrap the 33-bit counter relative to the previous timestamp.
    let delta = pts - (this.timing.prev % PTS_WRAP);
    if (delta < -PTS_WRAP / 2) delta += PTS_WRAP;
    else if (delta > PTS_WRAP / 2) delta -= PTS_WRAP;
    const abs = this.timing.prev + delta;
    const t = this.timing;
    t.prev = abs;
    if (abs > t.last) t.last = abs;
    if (abs < t.first) t.first = abs;
    // Duration is the sum of forward steps past the high-water mark: small backward steps are
    // B-frame reordering and add nothing; a step beyond the jump limit is a timestamp reset that
    // must neither inflate the duration nor trigger an early duration cut.
    const step = abs - t.high;
    if (Math.abs(step) > this.ptsJumpTicks) {
      // A forward jump is broadcast the CDN never sent us (media missing at the resume point);
      // a backward one is a timestamp reset. Per-part totals feed the end-of-part report.
      if (abs > t.high) {
        this.jumpSec += (abs - t.high) / PTS_HZ;
        this.jumpCount += 1;
      }
      this.onPtsJump?.({ fromSec: t.high / PTS_HZ, toSec: abs / PTS_HZ });
      t.high = abs;
    } else if (step > 0) {
      t.span += step;
      t.high = abs;
    }
    if (this.maxDurationTicks > 0 && this.cutPending === null && t.span >= this.maxDurationTicks) {
      this.cutPending = "duration";
    }
  }

  private parsePat(d: Buffer, o: number): void {
    const s = sectionStart(d, o);
    if (s < 0 || d[s] !== 0x00) return;
    const end = Math.min(s + 3 + (((d[s + 1] & 0x0f) << 8) | d[s + 2]) - 4, o + TS_PACKET);
    for (let j = s + 8; j + 4 <= end; j += 4) {
      const program = (d[j] << 8) | d[j + 1];
      if (program !== 0) {
        this.pmtPid = ((d[j + 2] & 0x1f) << 8) | d[j + 3];
        return;
      }
    }
  }

  private parsePmt(d: Buffer, o: number): void {
    const s = sectionStart(d, o);
    if (s < 0 || d[s] !== 0x02) return;
    const end = Math.min(s + 3 + (((d[s + 1] & 0x0f) << 8) | d[s + 2]) - 4, o + TS_PACKET);
    let j = s + 12 + (((d[s + 10] & 0x0f) << 8) | d[s + 11]);
    let video = -1;
    let first = -1;
    while (j + 5 <= end) {
      const type = d[j];
      const pid = ((d[j + 1] & 0x1f) << 8) | d[j + 2];
      if (first < 0) first = pid;
      if (video < 0 && (type === 0x1b || type === 0x24)) video = pid;
      j += 5 + (((d[j + 3] & 0x0f) << 8) | d[j + 4]);
    }
    this.videoPid = video;
    this.primaryPid = video >= 0 ? video : first;
  }
}
