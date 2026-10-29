/**
 * i18n-completeness.test.ts — 前端文案守门(web 无 vitest,用这个替代)。
 *
 * 起因:T15 写了 `t("settings.saving")` 但没加词典条目 —— 不报错、不崩,
 * 界面上直接显示 "settings.saving"。这类静默缺陷只有固化成检查才拦得住。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

describe("前端文案完整性", () => {
  it('代码里 t("...") 引用的 key 都存在,且中英键集对称', () => {
    let out = "";
    try {
      out = execFileSync("node", [join(ROOT, "scripts", "check-i18n.mjs")], { cwd: ROOT, encoding: "utf-8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`文案检查未通过:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
    }
    expect(out).toContain("✅");
  });
});
