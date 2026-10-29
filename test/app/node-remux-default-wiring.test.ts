/**
 * issue #140 × #137:节点侧原地替换的**默认 remux 接线**必须传 `{ atomic: false }`。
 *
 * 为什么单开一个文件:node-remux 的常规用例都注入 `deps.remux` 替身,`defaultRemux` 永远不会被跑到 ——
 * 于是「有没有传 atomic:false」这一行没有任何用例钉住(独立审查 M12 变异存活)。
 * 这里只 mock `@drec/post-process`(不碰真 ffmpeg),断言它收到的第 4 个参数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const remuxSegment = vi.hoisted(() => vi.fn(async (_src: string, out: string) => { writeFileSync(out, "dur=600 span=600"); }));
vi.mock("@drec/post-process", async (orig) => ({
  ...(await orig<typeof import("@drec/post-process")>()),
  remuxSegment,
}));

import { convertSegmentInPlace } from "../../packages/app/src/node-remux.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "node-remux-wire-")); remuxSegment.mockClear(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("节点侧原地替换:defaultRemux 接线(issue #140/#137)", () => {
  it("默认实现把 atomic:false 传给 remuxSegment(自己就是两阶段落盘,不能再套 .part)", async () => {
    const src = join(dir, "主播_2026-10-15_21-00-00_000.ts");
    writeFileSync(src, "dur=600 span=600");

    const r = await convertSegmentInPlace(src, "mkv", {
      // 只用假 probe / 假磁盘余量;remux 不注入 → 走 defaultRemux(被测接线)。
      probe: async () => ({ durationSec: 600, hasVideo: true, spanSec: 600, packets: 100, hasAudio: true, audioPackets: 100, scanErrors: 0 }),
      freeBytes: () => 1e12,
    });

    expect(r.ok).toBe(true);
    expect(vi.mocked(remuxSegment)).toHaveBeenCalledTimes(1);
    const [, outPath, fmt, opts] = vi.mocked(remuxSegment).mock.calls[0]!;
    expect(outPath.endsWith(".drec-remux")).toBe(true);              // 写的是调用方自己的临时名
    expect(fmt).toBe("mkv");
    expect(opts).toEqual({ atomic: false });                          // 关键断言:不得让 post-process 再套一层 .part
    expect(readFileSync(join(dir, "主播_2026-10-15_21-00-00_000.mkv"), "utf-8")).toBe("dur=600 span=600");
    expect(readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
  });
});
