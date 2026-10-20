/**
 * hub-config-store.ts — hub.config.json 里 **`resources` 段**的读写(T15)。
 *
 * 为什么单独一个文件:worker CRUD 已经在 worker-store.ts 里(同款「原子写 + 保留其它字段」),
 * 而 resources 是**另一类东西** —— 它不是节点列表,是**本机资源闸门**(CPU/网络并行度、烧录内存下限、
 * 上传限流)。两者写同一个文件,如果各写一份「读-改-写」逻辑,迟早会在某次并发里互相覆盖
 * (worker-store 保留非 worker 字段、resources 也保留非 resources 字段,各自都以为自己完整)。
 *
 * 真理源仍是 `<root>/config/hub.config.json`(**或 master 实际解析到的那份**,见
 * `resolveHubConfigJson` 的 source),本模块不新增存储、不迁数据:读时现读不缓存,
 * 所以手改文件与 UI 天然同步(与 workers 一致)。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

import type { HubResources } from "@drec/core";

// 类型本身放 core(app 与 orchestrator 共用);这里的 re-export 保持既有引用路径不变。
export type { HubResources } from "@drec/core";

/**
 * 默认值(唯一一份)。缺字段时回落这里 —— 与 cli/pipeline 现有默认值一致。
 *
 * 放在 store 而不是各消费点:三个(ResourcePool 构造、UI 默认值、回落读)各写一遍
 * `?? 1` / `?? 1024`,改一个默认值漏另一个是迟早的事(自审:这正是 T15 要消灭的模式)。
 */
export const DEFAULT_HUB_RESOURCES: Required<HubResources> = {
  maxCpuParallel: 1,
  maxNetParallel: 1,
  minBurnFreeMemMB: 1024,
  minMergeFreeMemMB: 512,
  memWaitTimeoutMs: 600_000,
  uploadRateLimit: 5,
  uploadRateWindowMs: 600_000,
  uploadCooldownMs: 1_800_000,
  maxConcurrentPipelines: 2,
};

interface HubConfigFile { resources?: Partial<HubResources>; [k: string]: unknown }

function readFile(path: string): HubConfigFile {
  try { return JSON.parse(readFileSync(path, "utf-8")) as HubConfigFile; }
  catch { return {}; }   // 缺失/坏 JSON → 空(与 worker-store 同口径:写时会重写出合法文件)
}

/**
 * 读 resources,缺字段用默认值补齐。
 *
 * **返回的是补齐后的完整对象**而不是原始 partial:调用方(ResourcePool)拿到就能直接用,
 * 不用在每个消费点各写一遍 `?? 默认值` —— 那正是「两处默认值漂移」的来源。
 */
export function readResources(configPath: string): HubResources {
  const raw = readFile(configPath).resources ?? {};
  return {
    maxCpuParallel: num(raw.maxCpuParallel, DEFAULT_HUB_RESOURCES.maxCpuParallel, 1),
    maxNetParallel: num(raw.maxNetParallel, DEFAULT_HUB_RESOURCES.maxNetParallel, 0),
    minBurnFreeMemMB: num(raw.minBurnFreeMemMB, DEFAULT_HUB_RESOURCES.minBurnFreeMemMB, 0),
    minMergeFreeMemMB: num(raw.minMergeFreeMemMB, DEFAULT_HUB_RESOURCES.minMergeFreeMemMB, 0),
    memWaitTimeoutMs: num(raw.memWaitTimeoutMs, DEFAULT_HUB_RESOURCES.memWaitTimeoutMs, 0),
    uploadRateLimit: num(raw.uploadRateLimit, DEFAULT_HUB_RESOURCES.uploadRateLimit, 1),
    uploadRateWindowMs: num(raw.uploadRateWindowMs, DEFAULT_HUB_RESOURCES.uploadRateWindowMs, 1),
    // 冷却允许 0(显式关闭),所以下限是 0 而不是 1。
    uploadCooldownMs: num(raw.uploadCooldownMs, DEFAULT_HUB_RESOURCES.uploadCooldownMs, 0),
    maxConcurrentPipelines: num(raw.maxConcurrentPipelines, DEFAULT_HUB_RESOURCES.maxConcurrentPipelines, 1),
  };
}

/** 非法值(非有限数 / 低于 min)一律回落到默认 —— 手改文件写坏了不该让服务起不来。 */
function num(v: unknown, dflt: number, min: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min) return dflt;
  return n;
}

/**
 * 校验(≥下限)。返回错误串;合法返回 null。
 * **先校验再落盘** —— 不能「先写进去再报错」,那会留下一个坏配置(下次启动直接读它)。
 */
export function validateResources(patch: Partial<HubResources>): string | null {
  const checks: Array<[keyof HubResources, number]> = [
    ["maxCpuParallel", 1], ["maxNetParallel", 0], ["minBurnFreeMemMB", 0], ["minMergeFreeMemMB", 0],
    ["memWaitTimeoutMs", 0], ["uploadRateLimit", 1], ["uploadRateWindowMs", 1],
    ["uploadCooldownMs", 0], ["maxConcurrentPipelines", 1],
  ];
  for (const [key, min] of checks) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return `${key} 必须是有限数字`;
    if (v < min) return `${key} 不能小于 ${min}`;
  }
  return null;
}

/**
 * 原子写 resources(**只覆盖 resources 键**,workers/workerSeq/其余字段原样保留)。
 *
 * 与 worker-store 同样的 temp+rename:读时现读不缓存,若写到一半被读会拿到半截 JSON。
 */
export function writeResources(configPath: string, patch: Partial<HubResources>): void {
  const cfg = readFile(configPath);
  mkdirSync(dirname(configPath), { recursive: true });
  const next: HubConfigFile = { ...cfg, resources: { ...(cfg.resources ?? {}), ...patch } };
  const tmp = join(dirname(configPath), `.${basename(configPath)}.tmp`);
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, configPath);
}
