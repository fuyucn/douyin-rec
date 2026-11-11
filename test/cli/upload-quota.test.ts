/**
 * issue #596 / 审计 P0-5: manual `upload` / `_upos-upload` must take the same
 * UploadGate (account cooldown + sliding window) and node UploadSlot as production.
 * The unit tests pin the helper's order/release/rate-limit behavior; the source
 * guard pins that both CLI commands actually call it (helper tests alone cannot).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UploadSlot } from "@drec/core";
import { runWithUploadQuota } from "../../packages/cli/src/upload-quota.js";

function harness(busy = false) {
  const events: string[] = [];
  const gate = {
    awaitSlot: vi.fn(async (_key: string): Promise<void> => { events.push("gate"); }),
    recordRateLimit: vi.fn((_key: string): void => { events.push("rate-limit"); }),
  };
  const slot: UploadSlot = {
    index: 0,
    acquire: vi.fn(async (): Promise<boolean> => { events.push("slot"); return !busy; }),
    release: vi.fn((): void => { events.push("release"); }),
    touch: vi.fn(),
    close: vi.fn(),
  };
  return { events, gate, slot };
}

const base = { cookiesPath: "/tmp/biliup-credentials", log: () => {}, slotWaitMs: 1000 };

describe("runWithUploadQuota (issue #596)", () => {
  it("先等账号配额、再拿槽位，提交后释放；顺序与生产一致", async () => {
    const { events, gate, slot } = harness();
    await runWithUploadQuota({ ...base, deps: { gate, slot, accountKey: "bilibili:acct" } }, async () => {
      events.push("upload");
    });
    expect(events).toEqual(["gate", "slot", "upload", "release"]);
    expect(gate.awaitSlot).toHaveBeenCalledWith("bilibili:acct");
  });

  it("提交命中 601 时记账号冷却（跨重启由 gate store 保留）", async () => {
    const { events, gate, slot } = harness();
    await expect(runWithUploadQuota({ ...base, deps: { gate, slot, accountKey: "bilibili:acct" } }, async () => {
      events.push("upload");
      throw new Error("biliup 失败: code: 601 您上传视频过快");
    })).rejects.toThrow("601");
    expect(events).toEqual(["gate", "slot", "upload", "rate-limit", "release"]);
    expect(gate.recordRateLimit).toHaveBeenCalledWith("bilibili:acct");
  });

  it("槽位等待超时 → 拒绝上传，绝不无锁提交", async () => {
    const { events, gate, slot } = harness(true);
    await expect(runWithUploadQuota({ ...base, deps: { gate, slot, accountKey: "bilibili:acct" } }, async () => {
      events.push("upload");
    })).rejects.toThrow("槽位被占用");
    expect(events).toEqual(["gate", "slot"]);
  });

  it("槽位库不可用（null）→ 仍过账号配额，不因槽位故障挡住上传", async () => {
    const { events, gate } = harness();
    await runWithUploadQuota({ ...base, deps: { gate, slot: null, accountKey: "bilibili:acct" } }, async () => {
      events.push("upload");
    });
    expect(events).toEqual(["gate", "upload"]);
  });
});

describe("manual upload 命令接线（source guard）", () => {
  const root = join(import.meta.dirname, "..", "..");
  const src = readFileSync(join(root, "packages/cli/src/cli.ts"), "utf-8");
  const uploadCmd = src.slice(src.indexOf('.command("upload")'), src.indexOf("// ─── Hub starter"));
  const uposCmd = src.slice(src.indexOf('.command("_upos-upload'), src.indexOf("// ─── _live-pump"));

  it("upload 走 helper，并暴露槽位等待上限", () => {
    expect(uploadCmd).toContain("runWithUploadQuota(");
    expect(uploadCmd).toContain("--slot-wait");
  });

  it("_upos-upload 走 helper（不再直接撞 submitStudio）", () => {
    expect(uposCmd).toContain("runWithUploadQuota(");
  });
});
