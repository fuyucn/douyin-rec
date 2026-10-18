// issue #223 scenario B: a manager sidecar write that read the file before the remux marker landed
// must not leave the session without nodeFormat once the source segment is deleted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSessionSidecar } from "@drec/manager";
import { convertSegmentInPlace, type MediaProbe, type NodeRemuxDeps, type RemuxOutcome } from "@drec/processors";

const B = "主播_2026-10-15_21-00-00";
const IDENTITY = { sessionBase: B, roomSlug: "room1", platform: "douyin", startMs: 1_000 };
let dir: string;
let base: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sidecar-race-")); base = join(dir, B); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sidecar = (): Record<string, unknown> => JSON.parse(readFileSync(`${base}.session.json`, "utf-8")) as Record<string, unknown>;
const writeRaw = (body: string): void => writeFileSync(`${base}.session.json`, body);

const probe = async (p: string): Promise<MediaProbe> => {
  const m = /dur=(\d+)/.exec(readFileSync(p, "utf-8"));
  const dur = m ? Number(m[1]) : 0;
  return { durationSec: dur, hasVideo: true, spanSec: dur, packets: dur === 0 ? 0 : 100 };
};
const fakeDeps: NodeRemuxDeps = {
  freeBytes: () => Number.MAX_SAFE_INTEGER,
  remux: async (s, t) => { copyFileSync(s, t); },
  probe,
  fsync: () => {},
};

describe("scenario B — real interleave of manager write and remux mark", () => {
  it("marker lost by a stale manager write is re-applied before the source is deleted", async () => {
    writeRaw(JSON.stringify(IDENTITY));
    const src = join(dir, `${B}_000.ts`);
    writeFileSync(src, "dur=60");
    let pending: Promise<RemuxOutcome> | undefined;
    writeSessionSidecar(base, { ...IDENTITY, title: "t" }, {
      afterRead: () => { pending = convertSegmentInPlace(src, "mp4", fakeDeps); },
    });
    // The first mark ran inside the manager's read -> write window and was overwritten: race reproduced.
    expect(sidecar().nodeFormat).toBeUndefined();
    expect(pending).toBeDefined();
    const outcome = await pending!;
    expect(outcome.ok).toBe(true);
    expect(sidecar()).toMatchObject({ ...IDENTITY, title: "t", nodeFormat: "mp4" });
    expect(existsSync(join(dir, `${B}_000.mp4`))).toBe(true);
    expect(existsSync(src)).toBe(false);
  });
});

describe("writeSessionSidecar — merge and atomic write", () => {
  it("carries an existing nodeFormat over and replaces the other fields", () => {
    writeRaw(JSON.stringify({ ...IDENTITY, nodeFormat: "mkv", title: "old" }));
    writeSessionSidecar(base, { ...IDENTITY, title: "new" });
    expect(sidecar()).toEqual({ ...IDENTITY, title: "new", nodeFormat: "mkv" });
  });

  it("does not invent a nodeFormat when the old file has none or a non-string one", () => {
    writeRaw(JSON.stringify({ ...IDENTITY, nodeFormat: 1 }));
    writeSessionSidecar(base, IDENTITY);
    expect(sidecar()).toEqual(IDENTITY);
  });

  it("unparsable existing file is overwritten with the new data, no throw", () => {
    writeRaw("{\"sessionBase\":");
    expect(() => writeSessionSidecar(base, IDENTITY)).not.toThrow();
    expect(sidecar()).toEqual(IDENTITY);
  });

  it("replaces the file instead of writing in place: a hard link keeps the old bytes", () => {
    writeRaw(JSON.stringify(IDENTITY));
    linkSync(`${base}.session.json`, `${base}.lnk`);
    writeSessionSidecar(base, { ...IDENTITY, title: "t" });
    expect(sidecar().title).toBe("t");
    expect(readFileSync(`${base}.lnk`, "utf-8")).toBe(JSON.stringify(IDENTITY));
  });

  it("missing file is created; no temp file is left after success", () => {
    writeSessionSidecar(base, IDENTITY);
    expect(sidecar()).toEqual(IDENTITY);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("afterRead hook runs between read and write (the write wins over a concurrent rewrite)", () => {
    writeRaw(JSON.stringify(IDENTITY));
    const order: string[] = [];
    writeSessionSidecar(base, { ...IDENTITY, title: "t" }, {
      afterRead: () => { order.push("hook"); writeRaw(JSON.stringify({ ...IDENTITY, nodeFormat: "mp4" })); },
    });
    order.push("done");
    expect(order).toEqual(["hook", "done"]);
    expect(sidecar().nodeFormat).toBeUndefined();
  });
});
