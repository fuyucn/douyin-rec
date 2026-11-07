/**
 * queue-live.ts — zero-disk live-upload lanes for the Queue page.
 *
 * Zero-disk runs never become hub QueueItem rows, so their live upload state comes from the
 * tasks query instead. Everything else on the page is derived in queue-flow.ts.
 */
import type { Task } from "../api/client";

export interface LiveUploadLane {
  taskId: number;
  room: string;
  name: string | null;
  workerId: string;
  workerName: string;
  partIndex?: number;
  state: string;
  bvid?: string;
  updatedAt: number;
}

const ACTIVE_LIVE = new Set(["waiting", "streaming", "submitting"]);

/** Zero-disk runs never become live QueueItem rows; build their lanes from the tasks query. */
export function liveUploadLanes(tasks: readonly Task[]): LiveUploadLane[] {
  return tasks.flatMap((t) => t.streamUpload === true
    ? (t.zeroDisk ?? []).flatMap((z) => z.live && ACTIVE_LIVE.has(z.live.state) ? [{
      taskId: t.id,
      room: t.room,
      name: t.name ?? t.anchorName ?? null,
      workerId: z.workerId,
      workerName: z.workerName,
      ...(z.live.currentPart ? { partIndex: z.live.currentPart.index } : {}),
      state: z.live.state,
      ...(z.live.bvid ? { bvid: z.live.bvid } : {}),
      updatedAt: z.live.updatedAt,
    }] : [])
    : []);
}
