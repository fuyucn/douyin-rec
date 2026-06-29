// packages/orchestrator/src/scan.ts
// 共享录像扫描函数：被 LocalTransport 和 _inventory CLI 子命令复用。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { groupSessions } from "@drec/post-process";
import type { NodeRecording } from "./transport.js";
import { readGaps } from "./gaps.js";

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
      const gaps = readGaps(join(dir, `${base}.gaps.json`));
      recordings.push({
        // 优先用录制端写进 gaps.json 的权威 roomSlug(跨节点一致);否则回退 anchorName 映射 / 目录名。
        // 解决:某节点 anchorName 未解析 → 回退目录名 → 与其他节点 slug 不一致 → 同场被切成两个 streamKey。
        roomSlug: gaps?.roomSlug ?? taskRooms[anchor] ?? anchor,
        sessionBase: base,
        tsFiles: g.ts.map((f) => join(dir, f)),
        xmlPath: join(dir, `${base}.xml`),
        durationSec,
        startMs: startMs === Infinity ? 0 : startMs,
        endMs,
        totalGapSec: gaps?.totalGapSec ?? 0,
      });
    }
  }
  return recordings;
}
