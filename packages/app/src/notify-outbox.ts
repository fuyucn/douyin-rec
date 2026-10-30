/**
 * notify-outbox.ts — node-side durable queue for notification events (issue #405).
 *
 * A managed node no longer sends Discord itself: every event is appended here and the master
 * pulls it over the existing SSH channel, then acks. That keeps one sender (the master) and
 * survives a master outage. Standalone (non-managed) nodes keep sending directly.
 */
import { DatabaseSync } from "node:sqlite";
import type { NotifyEvent } from "@drec/core";

export interface OutboxEvent {
  id: number;
  at: number;
  taskId: number | null;
  event: NotifyEvent;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_outbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  task_id INTEGER,
  payload TEXT NOT NULL,
  acked   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notify_outbox_unacked ON notify_outbox(acked, id);
`;

export class NotifyOutbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  /** Append one event; returns its monotonic id (the master's cursor). */
  append(taskId: number | null, event: NotifyEvent, now = Date.now()): number {
    const r = this.db
      .prepare("INSERT INTO notify_outbox(at, task_id, payload) VALUES(?,?,?)")
      .run(now, taskId, JSON.stringify(event));
    return Number(r.lastInsertRowid);
  }

  /** Unacked events with id > after, oldest first. */
  list(after = 0, limit = 200): OutboxEvent[] {
    const rows = this.db
      .prepare("SELECT id, at, task_id, payload FROM notify_outbox WHERE acked = 0 AND id > ? ORDER BY id LIMIT ?")
      .all(after, limit) as Array<{ id: number; at: number; task_id: number | null; payload: string }>;
    const out: OutboxEvent[] = [];
    for (const r of rows) {
      try {
        out.push({ id: r.id, at: r.at, taskId: r.task_id ?? null, event: JSON.parse(r.payload) as NotifyEvent });
      } catch {
        // Corrupt row: ack it so it cannot block the queue forever.
        this.ack([r.id]);
      }
    }
    return out;
  }

  /** Mark delivered (or poison) rows as done. Returns how many changed. */
  ack(ids: number[]): number {
    if (ids.length === 0) return 0;
    const stmt = this.db.prepare("UPDATE notify_outbox SET acked = 1 WHERE id = ?");
    let n = 0;
    for (const id of ids) n += Number(stmt.run(id).changes ?? 0);
    return n;
  }

  /** Drop acked rows older than the retention window. */
  prune(days = 7, now = Date.now()): number {
    const cut = now - days * 86_400_000;
    return Number(this.db.prepare("DELETE FROM notify_outbox WHERE acked = 1 AND at < ?").run(cut).changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
