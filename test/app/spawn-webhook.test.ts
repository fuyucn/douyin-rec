import { describe, it, expect } from "vitest";
import { resolveSpawnWebhook } from "../../packages/app/src/process/spawner.js";

/**
 * 子进程 Discord webhook 解析。回归:spawner 曾只读全局定值(env/program),漏掉 UI 在 settings
 * 表设的 `discordWebhook` → 录制子进程拿不到 --discord-webhook → 站内通知有、Discord 整场没有。
 * 修复 = 全局支持 getter(每次 spawn 读 settings)。
 */
describe("resolveSpawnWebhook（子进程 webhook 解析）", () => {
  const HOOK = "https://discord.com/api/webhooks/abc";
  const TASK_HOOK = "https://discord.com/api/webhooks/task";

  it("任务级 webhook 优先于全局", () => {
    expect(resolveSpawnWebhook(TASK_HOOK, HOOK)).toBe(TASK_HOOK);
  });

  it("任务无 webhook → 回落全局定值", () => {
    expect(resolveSpawnWebhook(null, HOOK)).toBe(HOOK);
    expect(resolveSpawnWebhook("", HOOK)).toBe(HOOK);
    expect(resolveSpawnWebhook("   ", HOOK)).toBe(HOOK);
  });

  it("全局为 getter → 每次求值(带上 settings 表 webhook,这是修复点)", () => {
    expect(resolveSpawnWebhook(null, () => HOOK)).toBe(HOOK);
    // getter 返回最新值(模拟 UI 设完后重新读 settings)
    let current: string | undefined = undefined;
    const g = (): string | undefined => current;
    expect(resolveSpawnWebhook(null, g)).toBeUndefined();
    current = HOOK;
    expect(resolveSpawnWebhook(null, g)).toBe(HOOK);
  });

  it("任务级 + getter 全局 → 仍任务级优先", () => {
    expect(resolveSpawnWebhook(TASK_HOOK, () => HOOK)).toBe(TASK_HOOK);
  });

  it("都没有 → undefined(不传 --discord-webhook)", () => {
    expect(resolveSpawnWebhook(null, undefined)).toBeUndefined();
    expect(resolveSpawnWebhook("", () => "")).toBeUndefined();
    expect(resolveSpawnWebhook(undefined, () => undefined)).toBeUndefined();
  });
});
