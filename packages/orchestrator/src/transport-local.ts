// packages/orchestrator/src/transport-local.ts
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { Transport, NodeInventory } from "./transport.js";
import { scanRecordings } from "./scan.js";

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
    const recordings = await scanRecordings(this.o.recordingsDir, taskRooms, this.o.ffprobe);
    return { tenantId: this.id, recordings };
  }

  async isDone(_roomSlug: string): Promise<boolean> { return true; }

  /** 同机:fs 判存在(全在才 true)。 */
  async exists(paths: string[]): Promise<boolean> {
    return paths.every((p) => existsSync(p));
  }

  /** 同机 pull：mkdir -p localDir，然后把每个文件复制进去（保留文件名）。 */
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    mkdirSync(localDir, { recursive: true });
    for (const src of remotePaths) {
      copyFileSync(src, join(localDir, basename(src)));
    }
  }
}
