/** Lease row for one processor kind. */
export const LEASE_MS = 30_000;

export interface LeaseRow {
  kind: string;
  owner: string;
  pid: number;
  heartbeatAt: number;
  expiresAt: number;
  handoverRequested: boolean;
}
