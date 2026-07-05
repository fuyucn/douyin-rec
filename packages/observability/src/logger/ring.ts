/**
 * app/task-logs.ts — TaskLogStore: per-task in-memory ring buffer of log lines.
 *
 * The web 详情/日志 page tails a task's recorder subprocess output. The
 * TaskManager routes each child stdout/stderr line (plus manager lifecycle
 * lines) here; the web api reads them back via GET /api/tasks/:id/logs.
 *
 * Deliberately dependency-free and synchronous so it is trivially unit-testable
 * and can be shared in-process between the manager and the http handlers. Each
 * appended line is prefixed with a wall-clock `[HH:MM:SS] ` timestamp. Per task
 * the buffer is capped (default 1000 lines) and drops the OLDEST line on
 * overflow (ring semantics).
 */

/** Zero-pad a number to 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `[HH:MM:SS]` for the given Date (local time). */
function stamp(d: Date): string {
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}]`;
}

export interface TaskLogStoreOpts {
  /** Max retained lines per task. Default 1000. Oldest dropped on overflow. */
  cap?: number;
  /** Clock injection for tests. Default () => new Date(). */
  now?: () => Date;
}

export class TaskLogStore {
  private readonly cap: number;
  private readonly now: () => Date;
  private readonly buffers = new Map<number, string[]>();

  constructor(opts: TaskLogStoreOpts = {}) {
    this.cap = opts.cap ?? 1000;
    this.now = opts.now ?? ((): Date => new Date());
  }

  /**
   * Append a timestamped line for a task. A multi-line `line` is split so each
   * physical line gets its own timestamp and counts against the cap. Empty
   * input is ignored.
   */
  append(taskId: number, line: string): void {
    const text = String(line ?? "");
    if (text.length === 0) return;
    const buf = this.buffers.get(taskId) ?? [];
    if (!this.buffers.has(taskId)) this.buffers.set(taskId, buf);
    const ts = stamp(this.now());
    for (const part of text.split("\n")) {
      buf.push(`${ts} ${part}`);
    }
    // Ring: drop oldest until within cap.
    if (buf.length > this.cap) buf.splice(0, buf.length - this.cap);
  }

  /** Return a COPY of the task's lines (oldest → newest). Empty if none. */
  get(taskId: number): string[] {
    return [...(this.buffers.get(taskId) ?? [])];
  }

  /** Drop all lines for a task. */
  clear(taskId: number): void {
    this.buffers.delete(taskId);
  }
}
