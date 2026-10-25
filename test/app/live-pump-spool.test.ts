/**
 * 0 落盘流式直传(plans/039)的孤儿 spool 清扫。
 *
 * 真实泄漏:kill 在段中途时该段从未进入 state,重启后续录只会新建文件,旧 spool 永远留着。
 * 清扫必须极窄:只删「本模块命名 + 不在 state + 超过宽限期」的文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanSpools, ORPHAN_SPOOL_GRACE_MS } from "../../packages/app/src/live-pump-spool.js";
import { spoolPathsToKeep } from "../../packages/zero-upload/src/live-pump.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "spool-sweep-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const age = (name: string, msAgo: number): void => {
  const t = new Date(Date.now() - msAgo);
  utimesSync(join(dir, name), t, t);
};

describe("sweepOrphanSpools", () => {
  it("删除孤儿,保留 state 引用的、新鲜的、非本模块命名的文件", () => {
    writeFileSync(join(dir, "live-pump-1000001-2.ts"), "orphan");
    age("live-pump-1000001-2.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);

    writeFileSync(join(dir, "live-pump-1000002-3.ts"), "fresh"); // 另一进程可能正在写
    writeFileSync(join(dir, "someone-else.ts"), "x");
    age("someone-else.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);

    writeFileSync(join(dir, "live-pump-1000004-4.ts"), "known");
    age("live-pump-1000004-4.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);
    const knownPath = join(dir, "live-pump-1000004-4.ts");

    const removed = sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: [knownPath] });

    expect(removed).toEqual(["live-pump-1000001-2.ts"]);
    expect(existsSync(join(dir, "live-pump-1000001-2.ts"))).toBe(false);
    expect(existsSync(join(dir, "live-pump-1000002-3.ts"))).toBe(true);
    expect(existsSync(join(dir, "someone-else.ts"))).toBe(true);
    expect(existsSync(knownPath)).toBe(true);
  });

  it("pending 引用的 spool 也要保留(它是「已发起上传、结果未确认」的唯一恢复副本)", () => {
    // Review #280 P1: the keep-set used to list `parts` only, so the WAL for an in-flight
    // submit was treated as an orphan. Recovery re-uploads that whole file, so deleting it
    // turns a recoverable part into an unrecoverable one.
    const part = join(dir, "live-pump-1000005-1.ts");
    const pending = join(dir, "live-pump-1000005-2.ts");
    writeFileSync(part, "confirmed part");
    writeFileSync(pending, "in-flight submit");
    age("live-pump-1000005-1.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);
    age("live-pump-1000005-2.ts", ORPHAN_SPOOL_GRACE_MS + 60_000); // 退避可比宽限期更久

    const keep = spoolPathsToKeep({
      schemaVersion: 1, room: "r", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      parts: [{ index: 0, spoolPath: part, filename: "a.ts", stem: "s", title: "P1", bytes: 1, durationSec: 1, confirmed: true }],
      pending: { kind: "append", partIndex: 1, stem: "s2", title: "P2", bytes: 1, durationSec: 1, spoolPath: pending },
      updatedAt: 1,
    });

    expect(sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: keep })).toEqual([]);
    expect(existsSync(pending)).toBe(true);   // 恢复依据没被清扫
    expect(existsSync(part)).toBe(true);
  });

  it("没有 state 时保留集为空(向后兼容:老 state 缺字段不炸)", () => {
    expect(spoolPathsToKeep(null)).toEqual([]);
  });

  it("宽限期边界:恰好等于宽限期的文件保留(只用严格更旧才删)", () => {
    writeFileSync(join(dir, "live-pump-1000003-5.ts"), "edge");
    age("live-pump-1000003-5.ts", ORPHAN_SPOOL_GRACE_MS - 5_000);
    expect(sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: [] })).toEqual([]);
    expect(existsSync(join(dir, "live-pump-1000003-5.ts"))).toBe(true);
  });

  it("目录不存在 → 不抛、返回空(启动路径永不因清扫失败)", () => {
    expect(sweepOrphanSpools({ spoolDir: join(dir, "missing"), knownSpoolPaths: [] })).toEqual([]);
  });

});

describe("issue #360: room-layout spool names", () => {
  it("sweeps both generations but never the held-gap sample", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-sweep-360-"));
    try {
      const old = join(dir, `live-pump-${Date.UTC(2026, 9, 24, 23, 22, 24)}-0.ts`);
      const room = join(dir, "live-pump-云念_2026-10-24_06-55-49_000.ts");
      const suffixed = join(dir, "live-pump-云念_2026-10-24_06-55-49_000-1.ts");
      const held = join(dir, "live-pump-云念_2026-10-24_06-55-49_000.held-gap.ts");
      const state = join(dir, "live-pump-room360.state.json");
      for (const f of [old, room, suffixed, held, state]) writeFileSync(f, "x");
      const oldTime = new Date(Date.now() - ORPHAN_SPOOL_GRACE_MS - 60_000);
      for (const f of [old, room, suffixed, held, state]) utimesSync(f, oldTime, oldTime);
      const removed = sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: [] });
      expect(removed.sort()).toEqual([
        `live-pump-${Date.UTC(2026, 9, 24, 23, 22, 24)}-0.ts`,
        "live-pump-云念_2026-10-24_06-55-49_000.ts",
        "live-pump-云念_2026-10-24_06-55-49_000-1.ts",
      ].sort());
      expect(existsSync(held)).toBe(true);
      expect(existsSync(state)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("issue #360: root sweep keep-set", () => {
  it("keeps another room's unconfirmed spool past the grace window", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-keep-360-"));
    try {
      const other = join(dir, "live-pump-otherroom.state.json");
      const otherSpool = join(dir, "live-pump-otherroom_2026-10-24_10-00-00_000.ts");
      writeFileSync(otherSpool, "x");
      writeFileSync(other, JSON.stringify({
        schemaVersion: 1, room: "douyin:999:2026-10-24", createdAt: 1, title: "t", tid: 21, tag: "x",
        private: true, parts: [{ index: 0, spoolPath: otherSpool, filename: "f", stem: "s", title: "P1", bytes: 1, durationSec: 1, confirmed: false }],
        updatedAt: 1,
      }));
      const stale = new Date(Date.now() - ORPHAN_SPOOL_GRACE_MS - 60_000);
      utimesSync(otherSpool, stale, stale);
      const keep = spoolPathsToKeep(JSON.parse(readFileSync(other, "utf-8")));
      expect(sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: keep })).toEqual([]);
      expect(existsSync(otherSpool)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
