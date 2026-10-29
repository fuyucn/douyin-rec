/**
 * shared-contract.test.ts — 「跨包共享常量/纯函数」的单一真理源漂移守护。
 *
 * 为什么需要:某些值/函数必须**逐字一致**地跨包使用(写方与读方各算一次路径/键),
 * 一旦有人手抄一份、后来只改了一处,就会出现「写得进去、读不出来」这类极难排查的错位。
 * 已踩过:`sanitizeKey`(streamKey → 目录名)在 pipeline/hub-jobs/cli/node-pipeline 共 6 处手抄,
 * 任一处改动不一致 → job 日志/舞台目录定位错位。
 *
 * 本测试扫描源码,禁止这些标识符的**内联再实现**(必须统一调 core 的单一实现)。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("跨包共享实现不得内联复制(单一真理源)", () => {
  it("sanitizeStreamKey:只允许定义在 core;其它包不得内联 `replace(/[:/]/g, \"_\")`", () => {
    const coreFile = join(ROOT, "packages", "core", "src", "hub-ledger-contract.ts");
    expect(existsSync(coreFile)).toBe(true);

    const offenders: string[] = [];
    for (const pkgDir of readdirSync(join(ROOT, "packages"))) {
      const src = join(ROOT, "packages", pkgDir, "src");
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const f of walk(src)) {
        if (f.endsWith(".test.ts")) continue; // 测试里造样本可自行拼
        if (f === coreFile) continue;         // 唯一允许的实现处
        const text = readFileSync(f, "utf-8");
        if (/replace\(\/\[:\/\]\/g\s*,\s*"_"\)/.test(text)) {
          offenders.push(f.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders, `应统一调用 @drec/core 的 sanitizeStreamKey,禁止内联实现:\n${offenders.join("\n")}`).toEqual([]);
  });
});
