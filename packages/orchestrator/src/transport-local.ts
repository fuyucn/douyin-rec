// packages/orchestrator/src/transport-local.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { groupSessions } from "@drec/post-process";
import type { Transport, NodeInventory, NodeRecording } from "./transport.js";
import { readGaps } from "./gaps.js";

export interface LocalOpts {
  id: string;
  recordingsDir: string;
  taskRooms: Record<string, string>; // anchorName(目录名) → roomSlug
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
}

export class LocalTransport implements Transport {
  readonly id: string;
  constructor(private o: LocalOpts) { this.id = o.id; }

  async listInventory(): Promise<NodeInventory> {
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
          roomSlug: this.o.taskRooms[anchor] ?? anchor,
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
  async pull(_remotePaths: string[], _localDir: string): Promise<void> { /* 同机无需拉 */ }
}
