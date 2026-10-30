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
    const a = box.append(1, ev("r1"));
    const b = box.append(1, ev("r2"));
    expect(box.list().map((e) => e.id)).toEqual([a, b]);
    expect(box.list(a).map((e) => e.id)).toEqual([b]);
  });

  it("drops acked events from the queue", () => {
    const a = box.append(null, ev("r1"));
    box.append(null, ev("r2"));
    expect(box.ack([a])).toBe(1);
    expect(box.list().map((e) => e.id)).toEqual([a + 1]);
  });

  it("prunes only acked rows past the retention window", () => {
    const now = Date.now();
    const oldAcked = box.append(null, ev("r1"), now - 30 * 86_400_000);
    const oldUnacked = box.append(null, ev("r2"), now - 30 * 86_400_000);
    const fresh = box.append(null, ev("r3"), now);
    box.ack([oldAcked, fresh]);
    expect(box.prune(7, now)).toBe(1);
    // The old row that was never delivered must survive, otherwise the master loses it.
    expect(box.list().map((e) => e.id)).toEqual([oldUnacked]);
  });

  it("caps a pull at the requested limit", () => {
    for (let i = 0; i < 5; i++) box.append(null, ev(`r${i}`));
    expect(box.list(0, 2)).toHaveLength(2);
  });
});
