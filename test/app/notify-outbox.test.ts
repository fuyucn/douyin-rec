import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotifyOutbox } from "../../packages/app/src/notify-outbox.js";

let dir = "";
let box: NotifyOutbox;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notify-outbox-"));
  box = new NotifyOutbox(join(dir, "outbox.db"));
});
afterEach(() => {
  box.close();
  rmSync(dir, { recursive: true, force: true });
});

const ev = (room: string): { kind: "recordStart"; anchor: string; room: string; quality: string } =>
  ({ kind: "recordStart", anchor: "a", room, quality: "origin" });

describe("NotifyOutbox", () => {
  it("returns unacked events in id order and respects the cursor", () => {
    const a = box.append(1, "r1", ev("r1"));
    const b = box.append(1, "r2", ev("r2"));
    expect(box.list().map((e) => e.id)).toEqual([a, b]);
    expect(box.list(a).map((e) => e.id)).toEqual([b]);
  });

  it("drops acked events from the queue", () => {
    const a = box.append(null, "r1", ev("r1"));
    box.append(null, "r2", ev("r2"));
    expect(box.ack([a])).toBe(1);
    expect(box.list().map((e) => e.id)).toEqual([a + 1]);
  });

  it("prunes rows past the retention window whether acked or not", () => {
    const now = Date.now();
    const oldAcked = box.append(null, "r1", ev("r1"), true, now - 30 * 86_400_000);
    const oldUnacked = box.append(null, "r2", ev("r2"), true, now - 30 * 86_400_000);
    const fresh = box.append(null, "r3", ev("r3"), true, now);
    box.ack([oldAcked]);
    expect(box.prune(7, 10_000, now)).toBe(2);
    expect(box.list().map((e) => e.id)).toEqual([fresh]);
    expect(oldUnacked).toBeLessThan(fresh);
  });

  it("caps a pull at the requested limit", () => {
    for (let i = 0; i < 5; i++) box.append(null, `r${i}`, ev(`r${i}`));
    expect(box.list(0, 2)).toHaveLength(2);
  });
});

describe("NotifyOutbox routing metadata", () => {
  it("keeps the room and the webhook intent for the master", () => {
    box.append(3, "douyin.123", { kind: "error", stage: "取流", message: "x" }, true);
    box.append(3, "douyin.123", { kind: "recordStart", anchor: "a", room: "douyin.123", quality: "origin" }, false);
    const rows = box.list();
    expect(rows.map((r) => [r.room, r.wantWebhook])).toEqual([["douyin.123", true], ["douyin.123", false]]);
  });
});

describe("NotifyOutbox concurrency", () => {
  it("lets a second connection append while the first is open", () => {
    const shared = join(dir, "shared.db");
    const a = new NotifyOutbox(shared);
    const b = new NotifyOutbox(shared);
    try {
      a.append(null, "r1", ev("r1"));
      b.append(null, "r2", ev("r2"));
      expect(a.list()).toHaveLength(2);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("NotifyOutbox bounds", () => {
  it("drops unacked rows older than the retention window", () => {
    const now = Date.now();
    const old = box.append(null, "r1", ev("r1"), true, now - 30 * 86_400_000);
    const fresh = box.append(null, "r2", ev("r2"), true, now);
    expect(box.prune(7, 10_000, now)).toBe(1);
    expect(box.list().map((e) => e.id)).toEqual([fresh]);
    expect(old).toBeLessThan(fresh);
  });

  it("keeps at most maxRows, dropping the oldest first", () => {
    const now = Date.now();
    for (let i = 0; i < 6; i++) box.append(null, `r${i}`, ev(`r${i}`), true, now);
    expect(box.prune(7, 3, now)).toBe(3);
    const ids = box.list().map((e) => e.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([4, 5, 6]);
  });
});
