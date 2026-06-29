// packages/orchestrator/src/transport-local.ts
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { Transport, NodeInventory } from "./transport.js";
import { scanRecordings } from "./scan.js";

export interface LocalOpts {
  id: string;
  recordingsDir: string;
  /** anchorName(目录名) → roomSlug。接受普通 Record 或 getter 函数（getter 每次调用时取最新快照）。 */
  taskRooms: Record<string, string> | (() => Record<string, string>);
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
  /**
   * 该 roomSlug 此刻是否还在本机录制中(用于 settle 判定是否收播)。
   * 不提供 → 默认「不在录」(isDone=true),保留旧行为。**多节点 master 必须注入**,
   * 否则 isDone 恒 true → settle 不等录完 → 周期对账边录边合并残片(踩过)。
   */
  isRoomRecording?: (roomSlug: string) => boolean;
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

  /** 该 room 还在本机录制 → 未收播(false);否则已收播(true)。注入 isRoomRecording 才生效,否则恒 true(旧行为)。 */
  async isDone(roomSlug: string): Promise<boolean> {
    return !(this.o.isRoomRecording?.(roomSlug) ?? false);
  }

  /** 同机:fs 判存在(全在才 true)。 */
  async exists(paths: string[]): Promise<boolean> {
    return paths.every((p) => existsSync(p));
  }

  /** 同机:fs 删除(逐个 rm,失败吞掉)。 */
  async cleanup(paths: string[]): Promise<void> {
    for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
  }

  /** 同机 pull：mkdir -p localDir，然后把每个文件复制进去（保留文件名）。 */
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    mkdirSync(localDir, { recursive: true });
    for (const src of remotePaths) {
      copyFileSync(src, join(localDir, basename(src)));
    }
  }
}
