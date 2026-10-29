import {
  applyLiveEvent,
  applyProgress,
  createLiveRunTracker,
  type LiveEvent,
  type LivePumpReporter,
  type LiveRunTracker,
  type LiveUploadSnapshot,
} from "@drec/core";
import { liveUploadPath, pruneLiveFiles, readLiveUploadFile, writeJsonAtomic, type LiveFile } from "./zero-disk-node.js";

/**
 * Single writer for one room's live file. Snapshot writes are throttled to 5s; terminal
 * events bypass the throttle so a clean exit is not later mistaken for a killed run.
 */
export class LiveUploadReporter implements LivePumpReporter {
  private tracker: LiveRunTracker;
  private lastWrite = 0;
  private readonly path: string;
  private readonly platform: string;
  private readonly roomSlug: string;

  constructor(o: {
    platform: string;
    roomSlug: string;
    now?: number;
    writeEveryMs?: number;
    write?: (path: string, value: unknown) => void;
  }) {
    this.path = liveUploadPath(o.platform, o.roomSlug);
    this.platform = o.platform;
    this.roomSlug = o.roomSlug;
    this.writeEveryMs = o.writeEveryMs ?? 5_000;
    this.writeImpl = o.write ?? writeJsonAtomic;
    const existing = readLiveUploadFile(this.path);
    const terminal = existing?.current
      ? existing.current.state === "finished" || existing.current.state === "failed" || existing.current.state === "stopped"
      : false;
    const fresh = (): LiveRunTracker => createLiveRunTracker({ mode: "zero-disk", platform: o.platform, roomSlug: o.roomSlug, now: o.now });
    this.tracker = !existing?.current
      ? fresh()
      : terminal
        // A new process starts a new archive: keep the finished run for review, never turn it
        // into a live "waiting" row or copy it into current.
        ? { current: fresh().current, previous: existing.current }
        : { current: existing.current, ...(existing.previous ? { previous: existing.previous } : {}) };
    // A fresh/terminal room gets the initial waiting snapshot; a resumable non-terminal archive
    // keeps its old pid/state until the first real event.
    if (!existing?.current || terminal) this.flush();
  }

  private readonly writeEveryMs: number;
  private readonly writeImpl: (path: string, value: unknown) => void;

  event(e: LiveEvent): void {
    this.tracker = applyLiveEvent(this.tracker, e);
    const terminal = e.kind === "run_end" || e.kind === "run_start" || e.kind === "part_confirmed" || e.kind === "part_failed";
    if (terminal) this.flush();
    else this.throttledFlush();
  }

  progress(p: { part: number; uploadedBytes: number; chunks: number }): void {
    this.tracker = applyProgress(this.tracker, p);
    this.throttledFlush();
  }

  private throttledFlush(): void {
    const now = Date.now();
    if (now - this.lastWrite < this.writeEveryMs) return;
    this.flush(now);
  }

  private flush(now = Date.now()): void {
    this.lastWrite = now;
    const file: LiveFile = {
      v: 1,
      platform: this.platform,
      roomSlug: this.roomSlug,
      pid: process.pid,
      updatedAt: now,
      current: this.tracker.current,
      ...(this.tracker.previous ? { previous: this.tracker.previous } : {}),
    };
    try { this.writeImpl(this.path, file); } catch { /* observability only */ }
    pruneLiveFiles(now);
  }

  /** Read back for tests and local API. */
  read(): { current?: LiveUploadSnapshot; previous?: LiveUploadSnapshot } | null {
    if (!existsSync(this.path)) return null;
    return readLiveUploadFile(this.path);
  }
}
import { existsSync } from "node:fs";
