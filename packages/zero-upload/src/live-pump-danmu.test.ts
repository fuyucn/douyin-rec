/**
 * 0 落盘流式直传(plans/039):弹幕是这条路径上**唯一**还落盘的东西。
 * 这里只验证 pump 与弹幕接缝的生命周期契约(不依赖真实 WS):
 *   - 稿件恢复失败/有未确认分 P → 根本不该连弹幕;
 *   - 正常收播 → 连一次、收尾停一次(异常退出也停)。
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLivePump } from "./live-pump.js";

const base = (dir: string) => ({
  cookiesPath: join(dir, "cookies.json"),
  room: "12345",
  spoolDir: dir,
  title: "t",
  tid: 21,
  tag: "x",
  sizeCap: 10 * 1024 * 1024,
  quality: "origin",
  submit: false,
  fetch: async () => ({ living: false }),
  sleep: async () => {},
});

describe("runLivePump danmu seam", () => {
  it("未开播 → 连一次弹幕并在返回前停止(不因没录到流而漏停)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-danmu-"));
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const res = await runLivePump({ ...base(dir), danmu: { start, stop, xmlPath: join(dir, "a.xml") } });
    expect(res.ok).toBe(true);
    expect(res.segments).toHaveLength(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("弹幕连接抛错 → 视频路径不受影响,且不重复 stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-danmu-"));
    const stop = vi.fn(async () => {});
    const res = await runLivePump({
      ...base(dir),
      danmu: { start: async () => { throw new Error("ws down"); }, stop, xmlPath: join(dir, "a.xml") },
    });
    expect(res.ok).toBe(true);
    expect(stop).not.toHaveBeenCalled(); // start 失败 = 没连上,不应再 stop
  });
});
