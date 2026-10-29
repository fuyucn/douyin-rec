import { describe, it, expect, vi } from "vitest";
import { DEFAULT_DISK_MIN_GB, freeBytesOf, freeGBOf, resolveDiskMinGB } from "../../packages/core/src/disk-watermark.js";
import { resolveDiskWatermarkBytes } from "../../packages/app/src/daemon.js";
import { diskWatermarkGate } from "../../packages/orchestrator/src/node-side-upload.js";

describe("resolveDiskMinGB — 磁盘水位统一解析口径(issue #38)", () => {
  it("缺省(undefined/null)→ 10GB,不告警", () => {
    const warn = vi.fn();
    expect(resolveDiskMinGB(undefined, warn)).toEqual({ gb: 10, source: "默认" });
    expect(resolveDiskMinGB(null, warn)).toEqual({ gb: 10, source: "默认" });
    expect(DEFAULT_DISK_MIN_GB).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });
  it("正常值原样生效,不告警", () => {
    const warn = vi.fn();
    expect(resolveDiskMinGB(25, warn)).toEqual({ gb: 25, source: "配置" });
    expect(resolveDiskMinGB(0.5, warn)).toEqual({ gb: 0.5, source: "配置" });
    expect(warn).not.toHaveBeenCalled();
  });
  it("显式 <=0 → 关闭(0),不告警", () => {
    const warn = vi.fn();
    expect(resolveDiskMinGB(0, warn)).toEqual({ gb: 0, source: "关闭" });
    expect(resolveDiskMinGB(-5, warn)).toEqual({ gb: 0, source: "关闭" });
    expect(warn).not.toHaveBeenCalled();
  });
  it.each([["字符串", "20"], ["非数字字符串", "abc"], ["NaN", Number.NaN], ["Infinity", Infinity], ["对象", {}], ["布尔", true]])(
    "%s → 回落 10GB 并告警一次",
    (_n, v) => {
      const warn = vi.fn();
      expect(resolveDiskMinGB(v, warn)).toEqual({ gb: 10, source: "默认" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("diskMinGB");
    },
  );
  it("无 warn 回调不抛", () => {
    expect(() => resolveDiskMinGB("abc")).not.toThrow();
  });

  // 各调用点口径一致:同一输入 → 同一阈值(daemon 字节 / 上传闸门 / core)
  it.each([
    ["缺省", undefined, 10],
    ["正常值", 25, 25],
    ["负数", -1, 0],
    ["零", 0, 0],
    ["字符串", "abc", 10],
    ["NaN", Number.NaN, 10],
  ])("调用点一致:%s", (_n, v, gb) => {
    expect(resolveDiskMinGB(v).gb).toBe(gb);
    // daemon:经 hub 配置 JSON(NaN 序列化为 null → 缺省口径,单独不测)
    if (!Number.isNaN(v)) {
      const json = JSON.stringify({ resources: v === undefined ? {} : { diskMinGB: v } });
      expect(resolveDiskWatermarkBytes(json)).toBe(gb * 1e9);
    }
    // 上传闸门:剩余 5GB 是否被拦 ⇔ 阈值 > 5(v 缺省在闸门里 = 旧调用方未注入 = 关闭,由 reconciler/cli 先解析)
    if (v !== undefined) {
      expect(diskWatermarkGate(5, v as number).ok).toBe(!(gb > 5));
    }
  });
});

describe("freeBytesOf / freeGBOf — 必须用 frsize(macOS bind mount 的 bsize 是 1MiB)", () => {
  it("frsize 存在且与 bsize 不同 → 用 frsize(否则放大 256 倍,水位闸门失效)", () => {
    // master 实测:Docker/OrbStack bind mount bsize=1MiB、frsize=4096、bavail=9427379。
    const bytes = freeBytesOf({ bavail: 9_427_379, bsize: 1_048_576, frsize: 4096 });
    expect(bytes).toBe(9_427_379 * 4096);
    expect(freeGBOf({ bavail: 9_427_379, bsize: 1_048_576, frsize: 4096 })).toBeCloseTo(38.6, 1);
  });

  it("Linux:bsize == frsize → 与旧口径一致", () => {
    expect(freeBytesOf({ bavail: 10_871_071, bsize: 4096, frsize: 4096 })).toBe(10_871_071 * 4096);
  });

  it("没有 frsize(旧 Node / 未知 fs)→ 回落 bsize", () => {
    expect(freeBytesOf({ bavail: 1000, bsize: 4096 })).toBe(4_096_000);
  });

  it("空值/0 不产生 NaN(bsize=0 且无 frsize → 0)", () => {
    expect(freeBytesOf({ bavail: 5, bsize: 0 })).toBe(0);
  });
});
