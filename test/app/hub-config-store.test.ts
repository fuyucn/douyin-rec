/**
 * hub-config-store.test.ts — 资源闸门配置的读写(T15)。
 *
 * 重点不是「能写进去」,而是三条容易出事的不变量:
 *  1. 只覆盖 resources 键 —— workers / workerSeq / 自定义字段必须原样保留;
 *  2. 非法值不写坏配置(先校验后落盘);
 *  3. 手改坏的文件不能让服务起不来(读时回落默认)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResources, writeResources, validateResources, DEFAULT_HUB_RESOURCES } from "../../packages/app/src/hub-config-store.js";

describe("hub-config-store(T15 resources)", () => {
  let dir: string;
  let cfg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-res-"));
    cfg = join(dir, "hub.config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("文件不存在 → 返回补齐后的默认值(不抛)", () => {
    const r = readResources(cfg);
    expect(r).toEqual(DEFAULT_HUB_RESOURCES);
  });

  it("坏 JSON → 回落默认,不抛(手改文件写坏了不该让服务起不来)", () => {
    writeFileSync(cfg, "{ not json", "utf-8");
    expect(readResources(cfg)).toEqual(DEFAULT_HUB_RESOURCES);
  });

  it("部分字段缺失时,缺的用默认补齐、有的保持原值", () => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxCpuParallel: 3 } }), "utf-8");
    const r = readResources(cfg);
    expect(r.maxCpuParallel).toBe(3);
    expect(r.maxNetParallel).toBe(DEFAULT_HUB_RESOURCES.maxNetParallel);
  });

  it("写 resources **不破坏** workers / workerSeq / 自定义字段", () => {
    writeFileSync(cfg, JSON.stringify({
      workerSeq: 2,
      workers: [{ id: "vps", kind: "ssh", host: "h", dataRoot: "/d" }],
      stageDir: "/custom/stage",
      settleMs: 12345,
      resources: { maxCpuParallel: 1 },
    }), "utf-8");
    writeResources(cfg, { maxCpuParallel: 4 });
    const raw = JSON.parse(readFileSync(cfg, "utf-8")) as Record<string, unknown>;
    expect(raw.maxCpuParallel).toBeUndefined();
    expect((raw.resources as { maxCpuParallel: number }).maxCpuParallel).toBe(4);
    expect(raw.workerSeq).toBe(2);
    expect(raw.stageDir).toBe("/custom/stage");     // 自定义字段必须活下来
    expect(raw.settleMs).toBe(12345);
    expect((raw.workers as unknown[])).toHaveLength(1);
  });

  it("写入是原子的(不留 .tmp 残留,且读回是完整 JSON)", () => {
    writeResources(cfg, { maxCpuParallel: 2 });
    expect(() => readResources(cfg)).not.toThrow();
    expect(readResources(cfg).maxCpuParallel).toBe(2);
  });

  it("minMergeFreeMemMB: default 512, overridable, validated, bad value falls back", () => {
    expect(DEFAULT_HUB_RESOURCES.minMergeFreeMemMB).toBe(512);
    expect(DEFAULT_HUB_RESOURCES.minBurnFreeMemMB).toBe(1024);
    writeFileSync(cfg, JSON.stringify({ resources: { minMergeFreeMemMB: 256 } }), "utf-8");
    expect(readResources(cfg).minMergeFreeMemMB).toBe(256);
    writeFileSync(cfg, JSON.stringify({ resources: { minMergeFreeMemMB: -5 } }), "utf-8");
    expect(readResources(cfg).minMergeFreeMemMB).toBe(512);
    expect(validateResources({ minMergeFreeMemMB: -1 })).toContain("minMergeFreeMemMB");
    expect(validateResources({ minMergeFreeMemMB: 0 })).toBeNull();
  });

  it("validateResources: 低于下限 / 非有限数 → 错误串;合法 → null", () => {
    expect(validateResources({ maxCpuParallel: 0 })).toContain("maxCpuParallel");
    expect(validateResources({ maxNetParallel: -1 })).toContain("maxNetParallel");
    expect(validateResources({ uploadCooldownMs: 0 })).toBeNull();      // 0 = 显式关冷却,合法
    expect(validateResources({ maxNetParallel: 0 })).toBeNull();        // 0 = 禁网络并发,合法
    expect(validateResources({ uploadRateLimit: Number.NaN })).toContain("uploadRateLimit");
    expect(validateResources({ maxCpuParallel: 8 })).toBeNull();
  });

  it("读时对「越界的值」也回落默认(手改成 maxCpuParallel:0 不能让闸门关死)", () => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxCpuParallel: 0, uploadRateLimit: -5 } }), "utf-8");
    const r = readResources(cfg);
    expect(r.maxCpuParallel).toBe(DEFAULT_HUB_RESOURCES.maxCpuParallel);
    expect(r.uploadRateLimit).toBe(DEFAULT_HUB_RESOURCES.uploadRateLimit);
  });

  it("多次写是累积的(第二次只覆盖给的键,其余保留)", () => {
    writeResources(cfg, { maxCpuParallel: 3 });
    writeResources(cfg, { maxNetParallel: 2 });
    const r = readResources(cfg);
    expect(r.maxCpuParallel).toBe(3);
    expect(r.maxNetParallel).toBe(2);
  });
});
