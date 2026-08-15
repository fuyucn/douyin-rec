import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveStageProducts, sessionBaseOfFile, sessionBasesOfFiles } from "./session-plan.js";

describe("sessionBaseOfFile", () => {
  it("ts/flv/xml/mp4 与 PART 分段归一到同一会话 base", () => {
    const base = "主播A_2026-08-14_23-08-10";
    expect(sessionBaseOfFile(`${base}.ts`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.flv`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.xml`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.mp4`)).toBe(base);
    expect(sessionBaseOfFile(`${base}-PART01.ts`)).toBe(base);
    expect(sessionBaseOfFile(`${base}-PART12.flv`)).toBe(base);
  });

  it("非会话命名返回 undefined", () => {
    expect(sessionBaseOfFile("2026-08-14.ts")).toBeUndefined();
    expect(sessionBaseOfFile("主播A_2026-08-14.ts")).toBeUndefined();
    expect(sessionBaseOfFile("主播A_2026-08-14_23-08-10.txt")).toBeUndefined();
  });
});

describe("sessionBasesOfFiles", () => {
  it("排序并按会话 base 去重（同场多分段只算一次）", () => {
    const files = [
      "主播A_2026-08-14_23-08-10-PART01.ts",
      "主播A_2026-08-14_23-08-10-PART02.ts",
      "主播A_2026-08-14_23-08-10.ts",
      "主播A_2026-08-14_23-09-00.ts",
      "主播B_2026-08-14_01-00-00.flv",
      "random.txt",
    ];
    expect(sessionBasesOfFiles(files)).toEqual([
      "主播A_2026-08-14_23-08-10",
      "主播A_2026-08-14_23-09-00",
      "主播B_2026-08-14_01-00-00",
    ]);
  });
});

describe("deriveStageProducts", () => {
  it("merge 产出已存在：按 dateName 推产物路径，sessionBases 来自源段", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-plan-merged-"));
    const dateName = "主播A_2026-08-14";
    for (const f of [
      `${dateName}.mp4`,
      `${dateName}_danmu.mp4`,
      `${dateName}_livechat.mp4`,
      `${dateName}.xml`,
      `${dateName}_23-08-10.ts`,
      `${dateName}_23-09-00-PART01.flv`,
    ]) writeFileSync(join(dir, f), "x");

    const p = deriveStageProducts(dir)!;
    expect(p.dateName).toBe(dateName);
    expect(p.sessionBase).toBe(`${dateName}_23-08-10`);
    expect(p.sessionBases).toEqual([`${dateName}_23-08-10`, `${dateName}_23-09-00`]);
    expect(p.plain).toBe(join(dir, `${dateName}.mp4`));
    expect(p.danmuMp4).toBe(join(dir, `${dateName}_danmu.mp4`));
    expect(p.livechatMp4).toBe(join(dir, `${dateName}_livechat.mp4`));
    expect(p.plainXml).toBe(join(dir, `${dateName}.xml`));
    expect(p.xmlArg).toBe(join(dir, `${dateName}.xml`));
  });

  it("merge 未产出：从源段反推 dateName/sessionBase，xmlArg 指向源 xml", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-plan-src-"));
    const dateName = "主播B_2026-08-14";
    for (const f of [
      `${dateName}_23-08-10-PART01.ts`,
      `${dateName}_23-08-10-PART02.ts`,
      `${dateName}_23-09-00.ts`,
      `${dateName}_23-08-10.xml`,
    ]) writeFileSync(join(dir, f), "x");

    const p = deriveStageProducts(dir)!;
    expect(p.dateName).toBe(dateName);
    expect(p.sessionBase).toBe(`${dateName}_23-08-10`);
    expect(p.sessionBases).toEqual([`${dateName}_23-08-10`, `${dateName}_23-09-00`]);
    expect(p.plain).toBe(join(dir, `${dateName}.mp4`));
    expect(p.xmlArg).toBe(join(dir, `${dateName}_23-08-10.xml`));
    expect(p.plainXml).toBe(join(dir, `${dateName}.xml`));
  });

  it("目录为空/不存在/无匹配文件 → null", () => {
    const empty = mkdtempSync(join(tmpdir(), "session-plan-empty-"));
    expect(deriveStageProducts(empty)).toBeNull();
    expect(deriveStageProducts(join(empty, "nope"))).toBeNull();
    writeFileSync(join(empty, "random.txt"), "x");
    expect(deriveStageProducts(empty)).toBeNull();
  });
});
