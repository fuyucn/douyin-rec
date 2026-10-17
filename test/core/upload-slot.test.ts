// plan 038 PR4: node-wide upload slot shared by rolling and queue uploads.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUploadSlot } from "@drec/core";
import { openUploadSlotStore } from "../../packages/core/src/upload-slot.js";

const dbPath = (): string => join(mkdtempSync(join(tmpdir(), "slot-")), "proc-queue.db");
const alive = (startedAt: string) => () => ({ pid: process.pid, startedAt, cmdline: "x" });

describe("upload slot", () => {
  it("only one holder per index across two connections (two processes)", async () => {
    const p = dbPath();
    const a = openUploadSlot(p, { concurrency: 1, probe: alive("t1") });
    const b = openUploadSlot(p, { concurrency: 1, probe: alive("t1") });
    expect(await a.acquire("rolling", 10)).toBe(true);
    expect(a.index).toBe(0);
    expect(await b.acquire("queue", 1)).toBe(false); // the other slot index is taken
    expect(b.index).toBeNull();
    a.release();
    expect(await b.acquire("queue", 10)).toBe(true);
    expect(b.index).toBe(0);
    a.close(); b.close();
  });

  it("two slots let both in, and release is idempotent", async () => {
    const p = dbPath();
    const a = openUploadSlot(p, { concurrency: 2, probe: alive("t1") });
    const b = openUploadSlot(p, { concurrency: 2, probe: alive("t1") });
    expect(await a.acquire("rolling", 10)).toBe(true);
    expect(await b.acquire("queue", 10)).toBe(true);
    expect([a.index, b.index].sort()).toEqual([0, 1]);
    b.release(); b.release();
    const c = openUploadSlot(p, { concurrency: 2, probe: alive("t1") });
    expect(await c.acquire("queue", 10)).toBe(true);
    a.close(); b.close(); c.close();
  });

  /** A fake clock whose sleeps advance it, so waiting code can actually reach its deadline. */
  function fakeClock(t = 0) {
    const clock = { t };
    return {
      clock,
      now: () => clock.t,
      sleep: (ms: number) => { clock.t += ms; return Promise.resolve(); },
    };
  }

  it("a dead holder's slot is reclaimed; a holder whose pid is still alive keeps it", async () => {
    const p = dbPath();
    const { clock, now } = fakeClock(1_000_000);
    const dead = openUploadSlot(p, { concurrency: 1, now, probe: () => null, leaseMs: 100, sleep: (ms) => { clock.t += ms; return Promise.resolve(); } } as never);
    expect(await dead.acquire("queue", 10)).toBe(true);
    const other = openUploadSlot(p, { concurrency: 1, now, probe: () => null, leaseMs: 100, sleep: (ms) => { clock.t += ms; return Promise.resolve(); } } as never);
    expect(await other.acquire("rolling", 1)).toBe(false); // lease still fresh
    clock.t += 200;
    expect(await other.acquire("rolling", 1)).toBe(false); // expired, but "cannot probe" is not proof of death
    const gone = openUploadSlot(p, {
      concurrency: 1, now, leaseMs: 100, sleep: (ms) => { clock.t += ms; return Promise.resolve(); },
      probe: (pid: number) => ({ pid: pid + 1, startedAt: "other", cmdline: "x" }), // pid reused: not the holder
    } as never);
    expect(await gone.acquire("rolling", 10)).toBe(true);
    expect(gone.index).toBe(0);
    gone.close();
    dead.close(); other.close();
  });

  it("a live holder keeps its slot even past the lease (missed heartbeats are not stealing)", async () => {
    const p = dbPath();
    const { clock, now } = fakeClock(0);
    const probe = (): { pid: number; startedAt: string; cmdline: string } => ({ pid: process.pid, startedAt: "same", cmdline: "x" });
    const a = openUploadSlot(p, { concurrency: 1, now, probe, leaseMs: 10, sleep: (ms) => { clock.t += ms; return Promise.resolve(); } } as never);
    expect(await a.acquire("rolling", 10)).toBe(true);
    clock.t += 10_000;
    const b = openUploadSlot(p, { concurrency: 1, now, probe, leaseMs: 10, sleep: (ms) => { clock.t += ms; return Promise.resolve(); } } as never);
    expect(await b.acquire("queue", 1)).toBe(false);
    a.touch();
    clock.t += 1;
    expect(await b.acquire("queue", 1)).toBe(false);
    a.close(); b.close();
  });

  it("touch only refreshes our own slot; a holder that lost the row cannot release someone else's", async () => {
    const p = dbPath();
    const store = openUploadSlotStore(p)!;
    const slot = openUploadSlot(p, { concurrency: 1, probe: alive("t1"), leaseMs: 100 });
    expect(await slot.acquire("queue", 10)).toBe(true);
    store.put(0, { kind: "rolling", pid: 999_999, startedAt: "other", heartbeatAt: 1, expiresAt: 10 });
    slot.touch();
    expect(store.holders().get(0)?.pid).toBe(999_999); // untouched: not ours
    slot.release();
    expect(store.holders().get(0)?.pid).toBe(999_999); // not deleted by a non-owner
    store.close(); slot.close();
  });

  it("no store means no coordination: acquire always succeeds and release is a no-op", async () => {
    const slot = openUploadSlot("/nonexistent-dir/x/y/proc-queue.db", { log: () => {} });
    expect(await slot.acquire("queue", 10)).toBe(true);
    expect(slot.index).toBeNull();
    slot.release();
    slot.close();
  });

  it("serialises concurrent attempts inside one process to at most `concurrency`", async () => {
    const p = dbPath();
    const slots = Array.from({ length: 5 }, () => openUploadSlot(p, { concurrency: 1, probe: alive("t1") }));
    const got = await Promise.all(slots.map((s) => s.acquire("queue", 30).then((ok) => (ok ? s : null))));
    expect(got.filter(Boolean)).toHaveLength(1);
    expect(got.filter(Boolean)[0]!.index).toBe(0);
    for (const s of slots) s.close();
  });

  it("two processes racing for the last slot grant it to exactly one", async () => {
    const p = dbPath();
    const a = openUploadSlot(p, { concurrency: 1, probe: alive("t1") });
    const b = openUploadSlot(p, { concurrency: 1, probe: alive("t1") });
    const wins = await Promise.all([a.acquire("queue", 30), b.acquire("rolling", 30)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    a.close(); b.close();
  });
});
