/**
 * Synthetic MPEG-TS for tests (no ffmpeg needed): PAT, PMT, then GOPs of video frames with one
 * audio packet per frame. Video PES carry PTS and keyframes carry random_access_indicator, which
 * is all {@link TsCutter} looks at.
 */
import { TS_PACKET } from "./ts-cutter.js";

export const VIDEO = 0x100;
export const AUDIO = 0x101;
export const PMT = 0x1000;

export function packet(pid: number, o: { pusi?: boolean; rai?: boolean; payload?: Buffer; cc?: number } = {}): Buffer {
  const p = Buffer.alloc(TS_PACKET, 0xff);
  p[0] = 0x47;
  p[1] = (o.pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  let at = 4;
  if (o.rai) {
    p[3] = 0x30 | ((o.cc ?? 0) & 0x0f); // adaptation + payload
    p[4] = 1;
    p[5] = 0x40;
    at = 6;
  } else {
    p[3] = 0x10 | ((o.cc ?? 0) & 0x0f);
  }
  o.payload?.copy(p, at);
  return p;
}

function section(tableId: number, body: number[]): Buffer {
  const len = 5 + body.length + 4; // header after length + body + crc
  return Buffer.from([0, tableId, 0xb0 | ((len >> 8) & 0x0f), len & 0xff, 0, 1, 0xc1, 0, 0, ...body, 0, 0, 0, 0]);
}

export const pat = (): Buffer => packet(0, { pusi: true, payload: section(0x00, [0, 1, 0xe0 | (PMT >> 8), PMT & 0xff]) });

export function pmt(streams: Array<[type: number, pid: number]>): Buffer {
  const body = [0xe0 | (VIDEO >> 8), VIDEO & 0xff, 0xf0, 0];
  for (const [type, pid] of streams) body.push(type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0);
  return packet(PMT, { pusi: true, payload: section(0x02, body) });
}

function ptsBytes(pts: number): number[] {
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 7) << 1),
    (pts >> 22) & 0xff,
    (((pts >> 15) & 0x7f) << 1) | 1,
    (pts >> 7) & 0xff,
    ((pts & 0x7f) << 1) | 1,
  ];
}

export const pes = (pts: number): Buffer => Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, ...ptsBytes(pts)]);

/** A PES header with no PTS (a stream whose video carries no media clock). */
export const pesNoPts = (): Buffer => Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x00, 0]);

/**
 * A synthetic stream: PAT, PMT, then `gops` GOPs of `framesPerGop` frames, each frame `pkts` packets + one audio packet.
 * `noPts` strips the video PTS; `jump` adds `ticks` to the PTS from GOP `atGop` on (a timestamp reset).
 */
export function stream(o: {
  gops: number; framesPerGop?: number; pkts?: number; video?: boolean; startPts?: number;
  noPts?: boolean; jump?: { atGop: number; ticks: number };
}): Buffer {
  const framesPerGop = o.framesPerGop ?? 4;
  const pkts = o.pkts ?? 3;
  const video = o.video ?? true;
  const out: Buffer[] = [pat(), pmt(video ? [[0x1b, VIDEO], [0x0f, AUDIO]] : [[0x0f, AUDIO]])];
  let pts = o.startPts ?? 90_000;
  for (let g = 0; g < o.gops; g++) {
    if (o.jump && g === o.jump.atGop) pts = (pts + o.jump.ticks) % 2 ** 33;
    for (let f = 0; f < framesPerGop; f++) {
      if (video) {
        out.push(packet(VIDEO, { pusi: true, rai: f === 0, payload: o.noPts ? pesNoPts() : pes(pts) }));
        for (let k = 1; k < pkts; k++) out.push(packet(VIDEO));
      }
      out.push(packet(AUDIO, { pusi: true, payload: pes(pts) }));
      pts = (pts + 3000) % 2 ** 33;
    }
  }
  return Buffer.concat(out);
}
