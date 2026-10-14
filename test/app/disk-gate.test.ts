/**
 * issue #96:新一场开播的磁盘水位准入(plans/033 W1-3a)。
 * 只拦「新一场」、不删文件、不打断录制;阈值现读(热改生效);测任务自己的输出目录所在卷。
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkNewBroadcastAdmission, effectiveHubConfigPath, makeManualStartAdmit, makeNewBroadcastGate, volumeFreeBytes } from "../../packages/app/src/disk-gate.js";
import { rootHubConfig } from "../../packages/app/src/paths.js";

const GB = 1e9;
const cfg = (diskMinGB: unknown): string => JSON.stringify({ resources: { diskMinGB } });
const base = (over: Partial<Parameters<typeof checkNewBroadcastAdmission>[0]> = {}) => ({
  outDir: "/task/out",
  hubConfigPath: "/cfg/hub.config.json",
  readConfig: () => cfg(15),
  freeBytes: () => 20 * GB,
  ...over,
});

describe("checkNewBroadcastAdmission", () => {
  it("剩余高于水位 → 放行", () => {
    expect(checkNewBroadcastAdmission(base({ freeBytes: () => 20 * GB }))).toEqual({ ok: true });
  });

  it("剩余等于水位 → 放行(与 daemon 闸门同口径:只有严格低于才拒)", () => {
    expect(checkNewBroadcastAdmission(base({ freeBytes: () => 15 * GB }))).toEqual({ ok: true });
  });

  it("剩余低于水位 → 拒绝,原因带剩余与水位数值", () => {
    const d = checkNewBroadcastAdmission(base({ freeBytes: () => 13.9 * GB }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toContain("13.9GB");
      expect(d.reason).toContain("15.0GB");
    }
  });

  it("测的是**任务自己的输出目录**(把 outDir 交给取空间函数),不是默认输出目录", () => {
    const seen: string[] = [];
    checkNewBroadcastAdmission(base({ outDir: "/mnt/other-disk/rec", freeBytes: (d) => { seen.push(d); return 100 * GB; } }));
    expect(seen).toEqual(["/mnt/other-disk/rec"]);
  });

  it("水位配置缺失(worker 节点没有 hub 配置)→ 回落默认 10GB,不是关闭", () => {
    expect(checkNewBroadcastAdmission(base({ readConfig: () => undefined, freeBytes: () => 9 * GB })).ok).toBe(false);
    expect(checkNewBroadcastAdmission(base({ readConfig: () => undefined, freeBytes: () => 11 * GB })).ok).toBe(true);
  });

  it("diskMinGB=0 → 关闭闸门(向后兼容)", () => {
    expect(checkNewBroadcastAdmission(base({ readConfig: () => cfg(0), freeBytes: () => 0.1 * GB }))).toEqual({ ok: true });
  });

  it("查不到剩余空间(null)→ 放行:探测失败绝不误拦录制", () => {
    expect(checkNewBroadcastAdmission(base({ freeBytes: () => null }))).toEqual({ ok: true });
  });

  it("配置 JSON 损坏 / 阈值非数字 → 回落默认并告警,不静默关闭", () => {
    const warn = vi.fn();
    expect(checkNewBroadcastAdmission(base({ readConfig: () => "{not json", freeBytes: () => 1 * GB, warn })).ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    const warn2 = vi.fn();
    expect(checkNewBroadcastAdmission(base({ readConfig: () => cfg("abc"), freeBytes: () => 1 * GB, warn: warn2 })).ok).toBe(false);
    expect(warn2).toHaveBeenCalled();
  });
});

describe("makeNewBroadcastGate:每次调用现读配置与剩余空间(热改生效)", () => {
  it("同一个闸门实例:改水位 / 空间回升后,下一次判定立即反映,无需重建", () => {
    let min = 15;
    let free = 13 * GB;
    const gate = makeNewBroadcastGate(base({ readConfig: () => cfg(min), freeBytes: () => free }));
    expect(gate().ok).toBe(false);   // 13 < 15
    min = 10;                        // 配置热改
    expect(gate().ok).toBe(true);    // 13 ≥ 10
    min = 15; free = 20 * GB;        // 空间回升
    expect(gate().ok).toBe(true);
  });
});

describe("volumeFreeBytes", () => {
  it("输出目录尚未创建 → 落到最近的已存在祖先目录取空间(不是 null)", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-vol-"));
    const free = volumeFreeBytes(join(root, "not", "created", "yet"));
    expect(typeof free).toBe("number");
    expect(free).toBeGreaterThan(0);
  });

  it("已存在目录 → 返回正数", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-vol2-"));
    mkdirSync(join(root, "a"));
    expect(volumeFreeBytes(join(root, "a"))).toBeGreaterThan(0);
  });
});

describe("拒绝决定带稳定去重键", () => {
  it("key 只含水位、不含实时剩余;剩余变化 key 不变,水位变化 key 才变", () => {
    const k = (free: number, min: number) => {
      const d = checkNewBroadcastAdmission(base({ readConfig: () => cfg(min), freeBytes: () => free * GB }));
      return d.ok ? null : d.key;
    };
    expect(k(9.9, 10)).toBe(k(9.5, 10));
    expect(k(9.9, 10)).not.toBe(k(9.9, 15));
    expect(k(9.9, 10)).toContain("10.0");
  });
});

describe("hub 配置路径口径(子进程 / 手动启动 / daemon 同源)", () => {
  const saved = process.env.DOUYIN_REC_HUB_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.DOUYIN_REC_HUB_CONFIG; else process.env.DOUYIN_REC_HUB_CONFIG = saved;
  });

  it("环境变量优先(serve --hub-config <文件> 传给子进程);未设 → 数据根默认文件", () => {
    delete process.env.DOUYIN_REC_HUB_CONFIG;
    expect(effectiveHubConfigPath()).toBe(rootHubConfig());
    process.env.DOUYIN_REC_HUB_CONFIG = "/custom/hub.json";
    expect(effectiveHubConfigPath()).toBe("/custom/hub.json");
    process.env.DOUYIN_REC_HUB_CONFIG = "   ";
    expect(effectiveHubConfigPath()).toBe(rootHubConfig());
  });

  it("makeManualStartAdmit:测任务自己的输出目录(缺省回落默认目录),并读 effectiveHubConfigPath", () => {
    process.env.DOUYIN_REC_HUB_CONFIG = "/custom/hub.json";
    const seen: { dir: string; cfgPath: string }[] = [];
    const admit = makeManualStartAdmit((d) => d ?? "/default/out", {
      readConfig: (p) => { seen.push({ dir: "", cfgPath: p }); return cfg(15); },
      freeBytes: (dir) => { seen[seen.length - 1]!.dir = dir; return 1 * GB; },
    });
    expect(admit("/mnt/task-disk").ok).toBe(false);
    expect(admit(undefined).ok).toBe(false);
    expect(seen).toEqual([
      { dir: "/mnt/task-disk", cfgPath: "/custom/hub.json" },
      { dir: "/default/out", cfgPath: "/custom/hub.json" },
    ]);
  });
});
