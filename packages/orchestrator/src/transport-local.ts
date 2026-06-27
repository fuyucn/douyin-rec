// packages/orchestrator/src/transport-local.ts
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { groupSessions } from "@drec/post-process";
import type { Transport, NodeInventory, NodeRecording } from "./transport.js";
import { readGaps } from "./gaps.js";

export interface LocalOpts {
  id: string;
  recordingsDir: string;
  /** anchorName(目录名) → roomSlug。接受普通 Record 或 getter 函数（getter 每次调用时取最新快照）。 */
  taskRooms: Record<string, string> | (() => Record<string, string>);
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
}

export class LocalTransport implements Transport {
  readonly id: string;
  constructor(private o: LocalOpts) { this.id = o.id; }

  private resolveTaskRooms(): Record<string, string> {
    return typeof this.o.taskRooms === "function" ? this.o.taskRooms() : this.o.taskRooms;
  }

  async listInventory(): Promise<NodeInventory> {
    const taskRooms = this.resolveTaskRooms();
    const recordings: NodeRecording[] = [];
    let anchors: string[] = [];
    try {
      anchors = readdirSync(this.o.recordingsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { anchors = []; }
    for (const anchor of anchors) {
      const dir = join(this.o.recordingsDir, anchor);
      const groups = groupSessions(readdirSync(dir));
      for (const [base, g] of Object.entries(groups)) {
        if (!g.ts.length) continue;
        let durationSec = 0, startMs = Infinity, endMs = 0;
        for (const f of g.ts) {
          const p = await this.o.ffprobe(join(dir, f));
          durationSec += p.durationSec;
          startMs = Math.min(startMs, p.startMs);
          endMs = Math.max(endMs, p.endMs);
        }
        const gaps = readGaps(join(dir, `${base}.gaps.json`));
        recordings.push({
          roomSlug: taskRooms[anchor] ?? anchor,
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
    return { tenantId: this.id, recordings };
  }

  async isDone(_roomSlug: string): Promise<boolean> { return true; }

  /** 同机 pull：mkdir -p localDir，然后把每个文件复制进去（保留文件名）。 */
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    mkdirSync(localDir, { recursive: true });
    for (const src of remotePaths) {
      copyFileSync(src, join(localDir, basename(src)));
    }
  }
}
