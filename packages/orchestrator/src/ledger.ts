import { DatabaseSync } from "node:sqlite";

export type JobState = "pending"|"settling"|"syncing"|"merging"|"uploading"|"done"|"failed"|"needs_manual";
export interface JobRow { streamKey: string; state: JobState; winnerTenant?: string; bv?: string; error?: string; updatedAt: number; }

export class SyncLedger {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs(
      streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerTenant TEXT, bv TEXT, error TEXT, updatedAt INTEGER NOT NULL)`);
  }
  private now(): number { return Number(this.db.prepare("SELECT unixepoch('now')*1000 AS t").get()!.t); }
  upsertPending(streamKey: string): { isNew: boolean } {
    const existing = this.get(streamKey);
    if (existing) return { isNew: false };
    this.db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run(streamKey, "pending", this.now());
    return { isNew: true };
  }
  get(streamKey: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM sync_jobs WHERE streamKey=?").get(streamKey) as JobRow | undefined;
    return r ?? null;
  }
  setState(streamKey: string, state: JobState, patch: { winnerTenant?: string; error?: string } = {}): void {
    this.db.prepare("UPDATE sync_jobs SET state=?, winnerTenant=COALESCE(?,winnerTenant), error=?, updatedAt=? WHERE streamKey=?")
      .run(state, patch.winnerTenant ?? null, patch.error ?? null, this.now(), streamKey);
  }
  markDone(streamKey: string, bv: string): void {
    this.db.prepare("UPDATE sync_jobs SET state='done', bv=?, error=NULL, updatedAt=? WHERE streamKey=?").run(bv, this.now(), streamKey);
  }
  listActive(): JobRow[] {
    return this.db.prepare("SELECT * FROM sync_jobs WHERE state NOT IN('done','needs_manual')").all() as JobRow[];
  }
  close(): void { this.db.close(); }
}
