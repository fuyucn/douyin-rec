/**
 * 0 落盘上传结果回写 hub 台账(plans/039)。
 *
 * 为什么需要:0 落盘不产录像文件,正常管线(扫描→选优→合并→上传)无对象可跑,
 * 房间会永远停在台账里没有结果。这里直接把「上传结果」写成终态。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordStreamUpload } from "./stream-upload-ledger.js";
import { SyncLedger } from "./ledger.js";

const KEY = "douyin:12345:2026-10-18";
let dir: string;
let db: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "su-ledger-")); db = join(dir, "x-sync.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recordStreamUpload", () => {
  it("新 job:建 pending 后直接落到 done 并带上 BV", () => {
    const r = recordStreamUpload({ syncDbPath: db, streamKey: KEY, bvid: "BV1su0000001", parts: 3 });
    expect(r.ok).toBe(true);
    expect(r.bvid).toBe("BV1su0000001");
    expect(r.alreadyTerminal).toBe(false);
    const l = new SyncLedger(db);
    const job = l.get(KEY);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV1su0000001");
    l.close();
  });

  it("重复写入幂等:不重复建 job、不覆盖已有终态", () => {
    recordStreamUpload({ syncDbPath: db, streamKey: KEY, bvid: "BV1su0000001", parts: 3 });
    const r2 = recordStreamUpload({ syncDbPath: db, streamKey: KEY, bvid: "BV1su9999999", parts: 5 });
    expect(r2.ok).toBe(true);
    expect(r2.alreadyTerminal).toBe(true);      // 已知是终态
    const l = new SyncLedger(db);
    // 第一个 BV 不被第二次写入覆盖(B 站无删稿,覆盖会指向一个不存在的稿件)。
    expect(l.get(KEY)?.bv).toBe("BV1su0000001");
    expect(l.get(KEY)?.state).toBe("done");
    l.close();
  });

  it("库路径不存在/不可写 → 返回失败而不抛(上传已成功,不能因台账失败而失败)", () => {
    const r = recordStreamUpload({ syncDbPath: join(dir, "nope", "x-sync.db"), streamKey: KEY, bvid: "BV1su0000002", parts: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
