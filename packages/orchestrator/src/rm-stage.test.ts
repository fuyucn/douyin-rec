/**
 * defaultRmStage(issue #429):stage 删除失败不再吞 —— 逐个尝试,全部试完后聚合抛错
 * (含失败路径数),调用方 catch → clean_* 步骤记 failed → reconciler 按既有补跑机制重试。
 * 删除动作本身不变(同一条 rmSync + force/recursive):本文件只验证「失败是否被看见」。
 */
import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRmStage } from "./pipeline.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("defaultRmStage(失败不再吞,issue #429)", () => {
  it("全部成功 → resolve 且文件删除(成功路径行为不变)", async () => {
    root = mkdtempSync(join(tmpdir(), "rmstage-ok-"));
    const a = join(root, "a.ts");
    const work = join(root, ".work"); mkdirSync(work); writeFileSync(join(work, "x"), "x");
    writeFileSync(a, "x");
    await expect(defaultRmStage([a, work])).resolves.toBeUndefined();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(work)).toBe(false); // recursive 语义保留:目录整体删
  });

  it("不存在的路径不算失败(rm -f 语义不变)", async () => {
    root = mkdtempSync(join(tmpdir(), "rmstage-miss-"));
    await expect(defaultRmStage([join(root, "nope.ts")])).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)("部分失败 → 聚合抛错(含失败路径数),逐个尝试:先失败不挡后面", async () => {
    root = mkdtempSync(join(tmpdir(), "rmstage-fail-"));
    const locked = join(root, "locked"); mkdirSync(locked);
    const a = join(locked, "a.ts"); writeFileSync(a, "x");
    const free = join(root, "free"); mkdirSync(free);
    const b = join(free, "b.ts"); writeFileSync(b, "x");
    chmodSync(locked, 0o500); // 只读父目录 → unlink 子文件 EACCES/EPERM(非 root 才生效)
    try {
      // locked 在前:它失败不得挡住 free 的删除。
      await expect(defaultRmStage([a, b])).rejects
        .toThrow(/stage 清理失败: 1\/2 个路径未删.*a\.ts:(EACCES|EPERM)/);
      expect(existsSync(a)).toBe(true);  // 失败者保留(留给补跑)
      expect(existsSync(b)).toBe(false); // 其余照删
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
