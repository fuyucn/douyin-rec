/**
 * Node-wide upload slot (plan 038 PR4).
 *
 * Both upload paths on a node write to the same B站 account and share the same uplink, so they must not run
 * biliup side by side: the queue's full-show upload and a recording process's rolling upload acquire the
 * same slot (per part, released right after) before spawning biliup.
 *
 * The slot lives in the node's process-queue database, one row per slot index, taken inside `BEGIN IMMEDIATE`.
 * A holder is identified by pid + start-time fingerprint, so a crashed process's slot is reclaimable while a
 * live process with a reused pid is not (same rule as child processes in `child-identity.ts`).
 */
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { isSameChild, probeChild, type ChildFingerprint } from "./child-identity.js";

/** Who wants the uplink: the whole-show queue upload, or a recording process uploading one sealed part. */
export type UploadSlotKind = "queue" | "rolling";

/**
 * No slot freed up within the caller's wait limit. This is transient (the other upload is still running), so
 * callers must retry later — never treat it as an uncertain outcome: nothing was uploaded.
 */
export const SLOT_BUSY_MARKER = "no free upload slot on this node";

export function isSlotBusy(e: unknown): boolean {
  return String((e as Error)?.message ?? e).includes(SLOT_BUSY_MARKER);
}

export interface UploadSlotHolder {
  kind: UploadSlotKind;
  pid: number;
  /** Start-time fingerprint of the holder (see `child-identity`); empty = unknown. */
  startedAt: string;
  /** Last heartbeat of the holder (epoch ms). */
  heartbeatAt: number;
  /** After this the holder is reclaimable even if its pid still exists (missed heartbeats). */
  expiresAt: number;
}

export interface UploadSlotStore {
  /** Live holders of every slot index; missing indexes are free. */
  holders(): Map<number, UploadSlotHolder>;
  /** Replace one slot row (or clear it with null). */
  put(index: number, holder: UploadSlotHolder | null): void;
  close(): void;
}

export interface UploadSlotOpts {
  /** Slot count; >= 1. */
  concurrency?: number;
  now?: () => number;
  /** Identity probe (tests inject); null result = process gone. */
  probe?: (pid: number) => ChildFingerprint | null;
  /** A holder that cannot heartbeat for this long loses the slot. */
  leaseMs?: number;
  busyTimeoutMs?: number;
  /** Poll interval while waiting (tests inject a sleep that moves their fake clock). */
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

export interface UploadSlot {
  /** Slot index (0-based), or null when the store is unusable. */
  readonly index: number | null;
  /** Wait until one slot is free, up to `timeoutMs`; false = gave up (caller keeps its own retry). */
  acquire(kind: UploadSlotKind, timeoutMs: number): Promise<boolean>;
  /** Give the slot back. Idempotent; safe to call without holding it. */
  release(): void;
  /** Refresh the heartbeat while a long upload is running (also done on acquire). */
  touch(): void;
  close(): void;
}

const DDL = `CREATE TABLE IF NOT EXISTS proc_upload_slot(
  idx INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  pid INTEGER NOT NULL,
  startedAt TEXT NOT NULL,
  heartbeatAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL)`;

export function openUploadSlotStore(dbPath: string, opts: UploadSlotOpts = {}): UploadSlotStore | null {
  const log = opts.log ?? ((m: string) => console.error(m));
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5_000}`);
    db.exec(DDL);
  } catch (e) {
    log(`[upload-slot] 打开 ${dbPath} 失败,上传槽不生效: ${(e as Error).message}`);
    return null;
  }
  const select = db.prepare("SELECT idx, kind, pid, startedAt, heartbeatAt, expiresAt FROM proc_upload_slot");
  return {
    holders() {
      const out = new Map<number, UploadSlotHolder>();
      for (const r of select.all() as Array<Record<string, unknown>>) {
        out.set(Number(r.idx), {
          kind: String(r.kind) as UploadSlotKind,
          pid: Number(r.pid),
          startedAt: String(r.startedAt),
          heartbeatAt: Number(r.heartbeatAt),
          expiresAt: Number(r.expiresAt),
        });
      }
      return out;
    },
    put(index, holder) {
      if (!holder) { db.prepare("DELETE FROM proc_upload_slot WHERE idx=?").run(index); return; }
      db.prepare(`INSERT INTO proc_upload_slot(idx, kind, pid, startedAt, heartbeatAt, expiresAt) VALUES(?,?,?,?,?,?)
        ON CONFLICT(idx) DO UPDATE SET kind=excluded.kind, pid=excluded.pid, startedAt=excluded.startedAt,
          heartbeatAt=excluded.heartbeatAt, expiresAt=excluded.expiresAt`)
        .run(index, holder.kind, holder.pid, holder.startedAt, holder.heartbeatAt, holder.expiresAt);
    },
    close() { db.close(); },
  };
}

export function openUploadSlot(dbPath: string, opts: UploadSlotOpts = {}): UploadSlot {
  const store = openUploadSlotStore(dbPath, opts);
  return makeUploadSlot(store, opts);
}

export function makeUploadSlot(store: UploadSlotStore | null, opts: UploadSlotOpts = {}): UploadSlot {
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? probeChild;
  const leaseMs = opts.leaseMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const count = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let held: number | null = null;

  /**
   * Reclaim only with proof that the recorded process is no longer that process: the pid now belongs to
   * something else. "Cannot probe" (null) is not proof — a pid-reused or unreadable process keeps its slot
   * until it is really gone, otherwise two uploads could run at once.
   */
  const reclaimable = (h: UploadSlotHolder, t: number): boolean => {
    if (t < h.expiresAt) return false;
    const cur = probe(h.pid);
    if (!cur) return false;
    return !isSameChild({ pid: h.pid, startedAt: h.startedAt }, cur);
  };

  const tryTake = (kind: UploadSlotKind, t: number): number | null => {
    if (held != null) return held;
    const live = store!.holders();
    const myPid = process.pid;
    const me = { kind, pid: myPid, startedAt: probe(myPid)?.startedAt ?? "", heartbeatAt: t, expiresAt: t + leaseMs };
    for (let i = 0; i < count; i++) {
      const h = live.get(i);
      if (h && !reclaimable(h, t)) continue;
      store!.put(i, me);
      // Re-read: another process may have won the same index between read and write.
      const back = store!.holders().get(i);
      if (back && back.pid === myPid && back.kind === kind) { held = i; return i; }
    }
    return null;
  };

  return {
    get index() { return held; },
    async acquire(kind, timeoutMs) {
      if (!store) return true; // no store = no coordination available; never block the upload
      const deadline = now() + timeoutMs;
      for (;;) {
        const idx = tryTake(kind, now());
        if (idx != null) return true;
        if (now() >= deadline) return false;
        await sleep(1_000);
      }
    },
    release() {
      if (!store || held == null) return;
      const h = store.holders().get(held);
      if (h && h.pid === process.pid) store.put(held, null);
      held = null;
    },
    touch() {
      if (!store || held == null) return;
      const h = store.holders().get(held);
      if (!h || h.pid !== process.pid) return;
      store.put(held, { ...h, heartbeatAt: now(), expiresAt: now() + leaseMs });
    },
    close() { store?.close(); held = null; },
  };
}
