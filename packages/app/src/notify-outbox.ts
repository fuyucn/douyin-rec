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
  /** The node's own task id: NOT the master's id space, only useful on the node. */
  taskId: number | null;
  /** Room URL/key, so the master can resolve the right task after sync. */
  room: string | null;
  /** Whether the master should deliver this to Discord (in-app-only events are false). */
  wantWebhook: boolean;
  event: NotifyEvent;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_outbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  task_id INTEGER,
  room    TEXT,
  want_webhook INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  acked   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notify_outbox_unacked ON notify_outbox(acked, id);
`;

export class NotifyOutbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // serve 与 `_notify-outbox` 命令是两个进程写同一个文件:WAL + busy_timeout 才不会一撞就丢事件。
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }

  /** Append one event; returns its monotonic id (the master's cursor). */
  append(taskId: number | null, room: string | null, event: NotifyEvent, wantWebhook = true, now = Date.now()): number {
    const r = this.db
      .prepare("INSERT INTO notify_outbox(at, task_id, room, want_webhook, payload) VALUES(?,?,?,?,?)")
      .run(now, taskId, room, wantWebhook ? 1 : 0, JSON.stringify(event));
    return Number(r.lastInsertRowid);
  }

  /** Unacked events with id > after, oldest first. */
  list(after = 0, limit = 200): OutboxEvent[] {
    const rows = this.db
      .prepare("SELECT id, at, task_id, room, want_webhook, payload FROM notify_outbox WHERE acked = 0 AND id > ? ORDER BY id LIMIT ?")
      .all(after, limit) as Array<{ id: number; at: number; task_id: number | null; room: string | null; want_webhook: number; payload: string }>;
    const out: OutboxEvent[] = [];
    for (const r of rows) {
      try {
        out.push({
          id: r.id, at: r.at, taskId: r.task_id ?? null, room: r.room ?? null,
          wantWebhook: r.want_webhook !== 0,
          event: JSON.parse(r.payload) as NotifyEvent,
        });
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
