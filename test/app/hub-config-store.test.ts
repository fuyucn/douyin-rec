/**
 * hub-config-store.test.ts — 资源闸门配置的读写(T15)。
 *
 * 重点不是「能写进去」,而是三条容易出事的不变量:
 *  1. 只覆盖 resources 键 —— workers / workerSeq / 自定义字段必须原样保留;
 *  2. 非法值不写坏配置(先校验后落盘);
 *  3. 手改坏的文件不能让服务起不来(读时回落默认)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResources, writeResources, validateResources, DEFAULT_HUB_RESOURCES } from "../../packages/app/src/hub-config-store.js";
import { createWorker } from "../../packages/app/src/worker-store.js";

const readFailure = vi.hoisted(() => ({ path: null as string | null, code: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: any, ...args: any[]) => {
      if (readFailure.path === String(path)) {
        throw Object.assign(new Error(`mock read failure: ${readFailure.code}`), { code: readFailure.code });
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

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


  it("内联 JSON 来源 → 用它自己的值(不是根文件/默认值,issue #473)", () => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxCpuParallel: 7 } }), "utf-8");
    const r = readResources({ json: JSON.stringify({ resources: { maxCpuParallel: 4, uploadRateLimit: 9 } }) });
    expect(r.maxCpuParallel).toBe(4);
    expect(r.uploadRateLimit).toBe(9);
    expect(r.minBurnFreeMemMB).toBe(DEFAULT_HUB_RESOURCES.minBurnFreeMemMB);
  });

  it("settings 来源(只有 json、没有 path)→ 用它自己的值", () => {
    const r = readResources({ json: JSON.stringify({ resources: { maxConcurrentPipelines: 5 } }) });
    expect(r.maxConcurrentPipelines).toBe(5);
  });

  it("文件来源({json, path} 都给了)→ 与只给 path 完全一致", () => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxNetParallel: 3 } }), "utf-8");
    expect(readResources({ json: readFileSync(cfg, "utf-8"), path: cfg })).toEqual(readResources(cfg));
  });

  it("json 优先于 path(解析出的那份才是实际生效的)", () => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxNetParallel: 1 } }), "utf-8");
    expect(readResources({ json: JSON.stringify({ resources: { maxNetParallel: 6 } }), path: cfg }).maxNetParallel).toBe(6);
  });

  it("坏的内联 JSON → 默认值,不抛", () => {
    expect(readResources({ json: "{ not json" })).toEqual(DEFAULT_HUB_RESOURCES);
    expect(readResources({ json: "null" })).toEqual(DEFAULT_HUB_RESOURCES);
  });

  it.each([
    ["坏 JSON", "{ not json"],
    ["空文件", ""],
    ["数组根形状", "[]"],
    ["null 根形状", "null"],
  ])("写入遇到 %s 时拒绝且原字节不变", (_label, contents) => {
    writeFileSync(cfg, contents, "utf-8");
    const original = readFileSync(cfg);
    expect(() => writeResources(cfg, { maxCpuParallel: 4 })).toThrow(/配置|JSON|根/);
    expect(readFileSync(cfg)).toEqual(original);
  });

  it.each(["EACCES", "EPERM", "EIO"])("读取 %s 时拒绝写且保留原文件", (code) => {
    writeFileSync(cfg, JSON.stringify({ resources: { maxCpuParallel: 2 } }), "utf-8");
    const original = readFileSync(cfg);
    readFailure.path = cfg;
    readFailure.code = code;
    try {
      expect(() => writeResources(cfg, { maxCpuParallel: 4 })).toThrow(code);
      expect(readResources(cfg)).toEqual(DEFAULT_HUB_RESOURCES); // 展示读取仍宽松
    } finally {
      readFailure.path = null;
      readFailure.code = null;
    }
    expect(readFileSync(cfg)).toEqual(original);
  });

  it("缺失配置首次创建 resources 后可继续写入", () => {
    writeResources(cfg, { maxCpuParallel: 4 });
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
    writeResources(cfg, { maxNetParallel: 3 });
    expect(readResources(cfg)).toMatchObject({ maxCpuParallel: 4, maxNetParallel: 3 });
    expect(JSON.parse(readFileSync(cfg, "utf-8")).workers[0].id).toBe("worker-1");
  });

  it("写 resources **不破坏** workers / workerSeq / 自定义字段", () => {
    writeFileSync(cfg, JSON.stringify({
      workerSeq: 2,
      workers: [{ id: "vps", kind: "ssh", host: "h", dataRoot: "/d" }],
      stageDir: "/custom/stage",
      settleMs: 12345,
      resources: { maxCpuParallel: 1, extension: { keep: true } },
    }), "utf-8");
    writeResources(cfg, { maxCpuParallel: 4 });
    const raw = JSON.parse(readFileSync(cfg, "utf-8")) as Record<string, unknown>;
    expect(raw.maxCpuParallel).toBeUndefined();
    expect(raw.resources).toMatchObject({ maxCpuParallel: 4, extension: { keep: true } });
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
