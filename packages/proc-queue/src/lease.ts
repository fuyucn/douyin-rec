import type { DatabaseSync } from "node:sqlite";
import { LEASE_MS, type LeaseRow } from "./lease-types.js";

type Row = Record<string, unknown>;

function toLease(r: Row): LeaseRow {
  return {
    kind: String(r.kind), owner: String(r.owner), pid: Number(r.pid),
    heartbeatAt: Number(r.heartbeatAt), expiresAt: Number(r.expiresAt),
    handoverRequested: Number(r.handoverRequested) === 1,
  };
}

export interface ProcLeaseOpts {
  now: () => number;
  isPidAlive: (pid: number) => boolean;
}

/** Lease rows for per-kind runner ownership (fencing source of truth). */
export class ProcLeaseStore {
  constructor(private readonly db: DatabaseSync, private readonly o: ProcLeaseOpts) {}

  getLease(kind: string): LeaseRow | null {
    const r = this.db.prepare("SELECT * FROM proc_runner_lease WHERE kind=?").get(kind) as Row | undefined;
    return r ? toLease(r) : null;
  }

  leaseKinds(): string[] {
    return (this.db.prepare("SELECT kind FROM proc_runner_lease").all() as Row[]).map((r) => String(r.kind));
  }

  leaseAlive(kind: string): boolean {
    const l = this.getLease(kind);
    return !!l && l.expiresAt > this.o.now();
  }

  leaseValid(kind: string, owner: string): boolean {
    const l = this.getLease(kind);
    return !!l && l.owner === owner && l.expiresAt > this.o.now();
  }

  acquireLease(
    kind: string, owner: string,
    opt: { pid?: number; leaseMs?: number; requestHandover?: boolean } = {},
  ): { acquired: boolean; takeover: boolean; holder?: LeaseRow } {
    const pid = opt.pid ?? process.pid;
    const leaseMs = opt.leaseMs ?? LEASE_MS;
    const t = this.o.now();
    const cur = this.getLease(kind);
    const mine = cur?.owner === owner;
    const stale = !cur || cur.expiresAt <= t || (cur.pid !== pid && !this.o.isPidAlive(cur.pid));
    if (cur && !mine && !stale) {
      if (opt.requestHandover) this.db.prepare("UPDATE proc_runner_lease SET handoverRequested=1 WHERE kind=?").run(kind);
      return { acquired: false, takeover: false, holder: cur };
    }
    // Freshly yielded to a handover requester: only a requester may take it until the reservation lapses.
    if (!mine && !opt.requestHandover && this.reservedUntil(kind) > t) return { acquired: false, takeover: false };
    this.db.prepare(
      `INSERT INTO proc_runner_lease(kind, owner, pid, heartbeatAt, expiresAt, handoverRequested)
       VALUES(?, ?, ?, ?, ?, 0)
       ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, heartbeatAt=excluded.heartbeatAt,
         expiresAt=excluded.expiresAt, handoverRequested=0`,
    ).run(kind, owner, pid, t, t + leaseMs);
    this.db.prepare("DELETE FROM proc_lease_reservation WHERE kind=?").run(kind);
    return { acquired: true, takeover: !!cur && !mine };
  }

  heartbeat(kind: string, owner: string, leaseMs = LEASE_MS): { ok: boolean; handoverRequested: boolean } {
    const t = this.o.now();
    const res = this.db.prepare("UPDATE proc_runner_lease SET heartbeatAt=?, expiresAt=? WHERE kind=? AND owner=?")
      .run(t, t + leaseMs, kind, owner);
    if (Number(res.changes) === 0) return { ok: false, handoverRequested: false };
    return { ok: true, handoverRequested: !!this.getLease(kind)?.handoverRequested };
  }

  /**
   * Reservation deadline for `kind` (0 = none). A reservation written "in the future" (the wall clock
   * jumped back since) is treated as void, so a backward jump cannot stretch it past its own period
   * (there is no pid check here). With t >= reservedAt, until - t never exceeds the reserved period.
   */
  reservedUntil(kind: string): number {
    const r = this.db.prepare("SELECT reservedAt, until FROM proc_lease_reservation WHERE kind=?").get(kind) as Row | undefined;
    if (!r) return 0;
    const t = this.o.now();
    const at = Number(r.reservedAt);
    const until = Number(r.until);
    if (t < at) return 0;
    return until;
  }

  /**
   * Give the lease up on a handover request: drop our row and reserve the kind for the requester for
   * `reserveMs`, atomically, so no other non-requesting runner (sibling record processes included)
   * grabs it in the gap and resets `handoverRequested` (#238 / #241). Returns false if we no longer held it.
   */
  yieldLease(kind: string, owner: string, reserveMs = LEASE_MS): boolean {
    const t = this.o.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const gone = Number(this.db.prepare("DELETE FROM proc_runner_lease WHERE kind=? AND owner=?").run(kind, owner).changes) > 0;
      if (gone) {
        this.db.prepare(
          `INSERT INTO proc_lease_reservation(kind, reservedAt, until) VALUES(?, ?, ?)
           ON CONFLICT(kind) DO UPDATE SET reservedAt=excluded.reservedAt, until=excluded.until`,
        ).run(kind, t, t + reserveMs);
      }
      this.db.exec("COMMIT");
      return gone;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  }

  releaseLease(kind: string, owner: string): boolean {
    return Number(this.db.prepare("DELETE FROM proc_runner_lease WHERE kind=? AND owner=?").run(kind, owner).changes) > 0;
  }
}
