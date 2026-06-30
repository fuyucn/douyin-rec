// packages/orchestrator/src/scan.ts
// 共享录像扫描函数：被 LocalTransport 和 _inventory CLI 子命令复用。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { groupSessions } from "@drec/post-process";
import type { NodeRecording } from "./transport.js";
import { readGaps, totalGapSecOf } from "./gaps.js";

interface GapInterval { startMs: number; endMs: number }

/**
 * 读会话 sidecar,取 roomSlug + platform + totalGapSec。
 * 新格式:`{base}.session.json`(身份+缺口合一,录制端 manager 写)。
 * 旧格式回落:`{base}.meta.json`(身份)+ `{base}.gaps.json`(缺口)—— 兼容历史录像。
 * 全缺失/损坏 → totalGapSec=0、roomSlug/platform=undefined。
 */
function readSession(dir: string, base: string): { roomSlug?: string; platform?: string; totalGapSec: number } {
  try {
    const d = JSON.parse(readFileSync(join(dir, `${base}.session.json`), "utf-8")) as
      { roomSlug?: string; platform?: string; totalGapSec?: number; gaps?: GapInterval[] };
    return {
      roomSlug: d.roomSlug || undefined,
      platform: d.platform || undefined,
      totalGapSec: d.totalGapSec ?? (d.gaps ? totalGapSecOf(d.gaps) : 0),
    };
  } catch { /* 无 session.json → 回落旧 meta+gaps */ }
  let roomSlug: string | undefined, platform: string | undefined;
  try {
    const m = JSON.parse(readFileSync(join(dir, `${base}.meta.json`), "utf-8")) as { roomSlug?: string; platform?: string };
    roomSlug = m.roomSlug || undefined; platform = m.platform || undefined;
  } catch { /* 无 meta */ }
  const g = readGaps(join(dir, `${base}.gaps.json`));
  return { roomSlug: roomSlug ?? g?.roomSlug, platform, totalGapSec: g?.totalGapSec ?? 0 };
}

export type FfprobeAdapter = (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;

/**
 * 扫描 recordingsDir 下所有主播子目录，聚合会话分段，返回 NodeRecording[]。
 *
 * @param recordingsDir  录像根目录（每个子目录 = 主播名）
 * @param taskRooms      anchorName → roomSlug 映射（未命中时 fallback 用目录名）
 * @param ffprobe        文件级时长/起止获取器（可注入 fake）
 */
export async function scanRecordings(
  recordingsDir: string,
  taskRooms: Record<string, string>,
  ffprobe: FfprobeAdapter,
): Promise<NodeRecording[]> {
  const recordings: NodeRecording[] = [];
  let anchors: string[] = [];
  try {
    anchors = readdirSync(recordingsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { anchors = []; }

  for (const anchor of anchors) {
    const dir = join(recordingsDir, anchor);
    const groups = groupSessions(readdirSync(dir));
    for (const [base, g] of Object.entries(groups)) {
      if (!g.ts.length) continue;
      let durationSec = 0, startMs = Infinity, endMs = 0;
      for (const f of g.ts) {
        const p = await ffprobe(join(dir, f));
        durationSec += p.durationSec;
        startMs = Math.min(startMs, p.startMs);
        endMs = Math.max(endMs, p.endMs);
      }
      const sess = readSession(dir, base);
      recordings.push({
        // slug = 房间号(web_rid)唯一 ID。优先级:session.json/旧 sidecar(随录像走、跨节点一致)
        // > taskRooms[主播名] > 目录名(后两者不可靠回退)。
        roomSlug: sess.roomSlug ?? taskRooms[anchor] ?? anchor,
        // platform 来自 sidecar(新录像必有);旧录像/缺省 → douyin(历史只有抖音)。
        platform: sess.platform ?? "douyin",
        sessionBase: base,
        tsFiles: g.ts.map((f) => join(dir, f)),
        xmlPath: join(dir, `${base}.xml`),
        durationSec,
        startMs: startMs === Infinity ? 0 : startMs,
        endMs,
        totalGapSec: sess.totalGapSec,
      });
    }
  }
  return recordings;
}
