/**
 * 假录制数据(E2E 脚手架):在临时目录里按真实录制端的落盘约定造「多会话 × 多分段 + 弹幕 xml +
 * session.json」。文件内容是一行 JSON(`{durationSec,startMs}`),由 {@link fakeFfprobe} 读回,
 * 因此 `scanRecordings` / `LocalTransport` / 聚类 / 选优全走真实代码。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionSpec {
  /** 会话首段开录时刻(epoch ms)。会话 base 由它按**本地时区**渲染,与 scan 的 startMsFromSessionBase 同口径。 */
  startMs: number;
  segments: number;
  segSec: number;
  /** 弹幕条目数(0 = 仅表头空 xml;undefined = 默认 5)。 */
  danmu?: number;
  title?: string;
  /** false → 不写 session.json 里的 title 等可选字段以外的东西(保留入口,当前恒写)。 */
}

export interface RecordingSpec {
  recordingsDir: string;
  anchor: string;
  platform?: string;
  roomSlug: string;
  sessions: SessionSpec[];
}

export interface WrittenSession {
  base: string;
  tsFiles: string[];
  xmlPath: string;
  sessionJson: string;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** 与 identity/scan 同口径(本地时区)渲染 `{anchor}_{YYYY-MM-DD}_{HH-mm-ss}`。 */
export function sessionBaseOf(anchor: string, startMs: number): string {
  const d = new Date(startMs);
  return `${anchor}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 固定的过去时刻(本地时区 10:00)——远早于重连窗,且避开跨日。 */
export function pastStartMs(dayOffset = 0, hour = 10, minute = 0): number {
  return new Date(2026, 5, 27 + dayOffset, hour, minute, 0).getTime();
}

function xmlBody(n: number): string {
  const rows = Array.from({ length: n }, (_, i) =>
    `<d p="${i},1,25,16777215,${1_700_000_000 + i},0,1,0" user="u${i}">弹幕${i}</d>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<i>\n<chatserver>chat.bilibili.com</chatserver>\n${rows.join("\n")}\n</i>\n`;
}

export function writeRecording(spec: RecordingSpec): WrittenSession[] {
  const dir = join(spec.recordingsDir, spec.anchor);
  mkdirSync(dir, { recursive: true });
  const out: WrittenSession[] = [];
  for (const s of spec.sessions) {
    const base = sessionBaseOf(spec.anchor, s.startMs);
    const tsFiles: string[] = [];
    for (let i = 0; i < s.segments; i++) {
      const p = join(dir, `${base}_${pad(i, 3)}.ts`);
      writeFileSync(p, JSON.stringify({ durationSec: s.segSec, startMs: s.startMs + i * s.segSec * 1000 }));
      tsFiles.push(p);
    }
    const xmlPath = join(dir, `${base}.xml`);
    writeFileSync(xmlPath, xmlBody(s.danmu ?? 5));
    const sessionJson = join(dir, `${base}.session.json`);
    writeFileSync(sessionJson, JSON.stringify({
      roomSlug: spec.roomSlug, platform: spec.platform ?? "douyin", gaps: [], totalGapSec: 0, title: s.title,
    }));
    out.push({ base, tsFiles, xmlPath, sessionJson });
  }
  return out;
}

/** 读回 {@link writeRecording} 写进 .ts 的元信息。读不到 → 抛错(= 源文件缺失,测试应当失败)。 */
export async function fakeFfprobe(file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> {
  const j = JSON.parse(readFileSync(file, "utf-8")) as { durationSec: number; startMs: number };
  return { durationSec: j.durationSec, startMs: j.startMs, endMs: j.startMs + j.durationSec * 1000 };
}
