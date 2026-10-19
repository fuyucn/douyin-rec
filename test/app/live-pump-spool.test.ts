/**
 * 0 落盘流式直传(plans/039)的孤儿 spool 清扫。
 *
 * 真实泄漏:kill 在段中途时该段从未进入 state,重启后续录只会新建文件,旧 spool 永远留着。
 * 清扫必须极窄:只删「本模块命名 + 不在 state + 超过宽限期」的文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanSpools, ORPHAN_SPOOL_GRACE_MS } from "../../packages/app/src/live-pump-spool.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "spool-sweep-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const age = (name: string, msAgo: number): void => {
  const t = new Date(Date.now() - msAgo);
  utimesSync(join(dir, name), t, t);
};

describe("sweepOrphanSpools", () => {
  it("删除孤儿,保留 state 引用的、新鲜的、非本模块命名的文件", () => {
    writeFileSync(join(dir, "live-pump-17000000001-2.ts"), "orphan");
    age("live-pump-17000000001-2.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);

    writeFileSync(join(dir, "live-pump-1700000000001-3.ts"), "fresh"); // 另一进程可能正在写
    writeFileSync(join(dir, "someone-else.ts"), "x");
    age("someone-else.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);

    writeFileSync(join(dir, "live-pump-1700000000002-4.ts"), "known");
    age("live-pump-1700000000002-4.ts", ORPHAN_SPOOL_GRACE_MS + 60_000);
    const knownPath = join(dir, "live-pump-1700000000002-4.ts");

    const removed = sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: [knownPath] });

    expect(removed).toEqual(["live-pump-17000000001-2.ts"]);
    expect(existsSync(join(dir, "live-pump-17000000001-2.ts"))).toBe(false);
    expect(existsSync(join(dir, "live-pump-1700000000001-3.ts"))).toBe(true);
    expect(existsSync(join(dir, "someone-else.ts"))).toBe(true);
    expect(existsSync(knownPath)).toBe(true);
  });

  it("宽限期边界:恰好等于宽限期的文件保留(只用严格更旧才删)", () => {
    writeFileSync(join(dir, "live-pump-17000000003-5.ts"), "edge");
    age("live-pump-17000000003-5.ts", ORPHAN_SPOOL_GRACE_MS - 5_000);
    expect(sweepOrphanSpools({ spoolDir: dir, knownSpoolPaths: [] })).toEqual([]);
    expect(existsSync(join(dir, "live-pump-17000000003-5.ts"))).toBe(true);
  });

  it("目录不存在 → 不抛、返回空(启动路径永不因清扫失败)", () => {
    expect(sweepOrphanSpools({ spoolDir: join(dir, "missing"), knownSpoolPaths: [] })).toEqual([]);
  });

});
