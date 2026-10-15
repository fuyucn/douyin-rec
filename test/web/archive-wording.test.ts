/**
 * archive-wording.test.ts — issue #135:界面把 stage 统一称「存档」,清理开关两处表单共用同一映射。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "packages", "web", "src");
const read = (rel: string): string => readFileSync(join(WEB, rel), "utf-8");

/** 与 scripts/check-i18n.mjs 同一做法抽出 DICT(i18n.tsx 依赖 React,不直接 import)。 */
function loadDict(): { zh: Record<string, unknown>; en: Record<string, unknown> } {
  const src = read("lib/i18n.tsx");
  const eq = src.indexOf("=", src.indexOf("const DICT"));
  const open = src.indexOf("{", eq);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return (0, eval)("(" + src.slice(open, end) + ")");
}

function values(o: Record<string, unknown>, p = ""): Array<[string, string]> {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? values(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]);
}

describe("界面用词:stage → 存档", () => {
  const dict = loadDict();
  // `{stage}` 是「出错[同步]」里的流水线阶段占位符,不是 stage 目录。
  const strip = (v: string): string => v.replaceAll("{stage}", "");
  it("中文词典用户可见值不再出现 stage / 只合成 / 仅合成", () => {
    const bad = values(dict.zh).filter(([, v]) => /stage|只合成|仅合成/i.test(strip(v)));
    expect(bad).toEqual([]);
  });
  it("英文词典不再出现 Stage only / Compose only / staged", () => {
    const bad = values(dict.en).filter(([, v]) => /stage only|compose only|staged|\bstage\b/i.test(strip(v)));
    expect(bad).toEqual([]);
  });
  it("新锁原因 key 中英都有", () => {
    const has = (d: Record<string, unknown>): unknown => ((d.roomForm as Record<string, any>).lock as Record<string, unknown>).needUploadForCleanArchive;
    expect(has(dict.zh)).toBeTruthy();
    expect(has(dict.en)).toBeTruthy();
  });
});

describe("房间面板与 Hub 规则弹窗共用同一份清理映射", () => {
  for (const file of ["modals/RoomEditPanel.tsx", "modals/HubRuleDialog.tsx"]) {
    it(`${file}:读入走 keepArchiveFromStored,写回走 storedFromForm,无第二套`, () => {
      const src = read(file);
      expect(src).toContain("keepArchiveFromStored(");
      expect(src).toContain("stageAfterDone: stored.stageAfterDone");
      expect(src).not.toMatch(/stageAfterDone:\s*form\./);
      expect(src).not.toMatch(/stageAfterDone\s*===\s*true/);
    });
  }
});
