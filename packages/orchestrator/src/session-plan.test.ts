import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSegmentPlan, deriveStageProducts, prepareUploadAlias, segmentStem, sessionBaseOfFile, sessionBasesOfFiles, UPLOAD_ALIAS_DIR } from "./session-plan.js";

describe("sessionBaseOfFile", () => {
  it("ts/flv/xml/mp4 与 PART 分段归一到同一会话 base", () => {
    const base = "主播A_2026-08-14_23-08-10";
    expect(sessionBaseOfFile(`${base}.ts`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.flv`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.xml`)).toBe(base);
    expect(sessionBaseOfFile(`${base}.mp4`)).toBe(base);
    expect(sessionBaseOfFile(`${base}-PART01.ts`)).toBe(base);
    expect(sessionBaseOfFile(`${base}-PART12.flv`)).toBe(base);
    // 本项目录制器的裸段号(_000)与 biliLive 下划线段号(_PART001)
    expect(sessionBaseOfFile(`${base}_000.ts`)).toBe(base);
    expect(sessionBaseOfFile(`${base}_017.flv`)).toBe(base);
    expect(sessionBaseOfFile(`${base}_PART001.ts`)).toBe(base);
  });

  it("merge 未产出 mp4 时,能从 _NNN.ts 源段反推 stage 产物(续跑/立即执行)", () => {
    const stage = mkdtempSync(join(tmpdir(), "session-plan-"));
    const base = "主播A_2026-08-14_23-08-10";
    writeFileSync(join(stage, `${base}_000.ts`), "x");
    writeFileSync(join(stage, `${base}_001.ts`), "x");
    const prod = deriveStageProducts(stage);
    expect(prod?.sessionBase).toBe(base);
    expect(prod?.dateName).toBe("主播A_2026-08-14");
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

describe("segmentStem / deriveSegmentPlan（分段上传）", () => {
  it("segmentStem 补零 3 位，保证字典序 = 段序", () => {
    expect(segmentStem("主播A_2026-08-14", 0)).toBe("主播A_2026-08-14_000");
    expect(segmentStem("主播A_2026-08-14", 12)).toBe("主播A_2026-08-14_012");
  });

  it("从 stage 反推分段产物：plain/danmu/livechat 按段号归并、跳过无 plain 的段", () => {
    const dir = mkdtempSync(join(tmpdir(), "segment-plan-"));
    const name = "主播A_2026-08-14";
    for (const f of [
      `${name}_000.mp4`,
      `${name}_000_danmu.mp4`,
      `${name}_000_livechat.mp4`,
      `${name}_001.mp4`,
      `${name}_002_danmu.mp4`, // 无 plain → 该段不算
      "random.txt",
    ]) writeFileSync(join(dir, f), "x");

    const plan = deriveSegmentPlan(dir)!;
    expect(plan.dateName).toBe(name);
    expect(plan.parts.map((p) => p.index)).toEqual([0, 1]);
    expect(plan.parts[0].plain).toBe(join(dir, `${name}_000.mp4`));
    expect(plan.parts[0].danmu).toBe(join(dir, `${name}_000_danmu.mp4`));
    expect(plan.parts[0].livechat).toBe(join(dir, `${name}_000_livechat.mp4`));
    expect(plan.parts[1].danmu).toBe("");
  });

  it("无分段产物 → null", () => {
    const empty = mkdtempSync(join(tmpdir(), "segment-plan-empty-"));
    expect(deriveSegmentPlan(empty)).toBeNull();
    expect(deriveSegmentPlan(join(empty, "nope"))).toBeNull();
  });

  it("allowedIndices 白名单:只认本次有效段号(续跑防误传历史残留)", () => {
    const dir = mkdtempSync(join(tmpdir(), "segment-plan-allow-"));
    const name = "主播A_2026-08-14";
    // stage 里 0..4 都有规范 mp4,但只有 0/2/4 是本次有效分 P
    for (const i of [0, 1, 2, 3, 4]) writeFileSync(join(dir, `${name}_00${i}.mp4`), "x");
    const plan = deriveSegmentPlan(dir, new Set([0, 2, 4]))!;
    expect(plan.parts.map((p) => p.index)).toEqual([0, 2, 4]);
  });

  it("只认规范命名:旧内部名 _segNNN / _gNNN 一律忽略", () => {
    const dir = mkdtempSync(join(tmpdir(), "segment-plan-legacy-"));
    const name = "主播A_2026-08-14";
    for (const f of [`${name}_seg000.mp4`, `${name}_g000.mp4`, `${name}_000.mp4`]) writeFileSync(join(dir, f), "x");
    const plan = deriveSegmentPlan(dir)!;
    expect(plan.parts).toHaveLength(1);
    expect(plan.parts[0].plain).toBe(join(dir, `${name}_000.mp4`));
  });
});

describe("prepareUploadAlias(分P标题 → 文件名)", () => {
  it("建硬链接到 .upload/<标题>.mp4,原文件不动(同步数,零拷贝)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "主播_2026-09-12_x.mp4");
    writeFileSync(canonical, "video-bytes");
    const out = prepareUploadAlias(dir, "plain", canonical, "主播_P1");
    expect(out).toBe(join(dir, UPLOAD_ALIAS_DIR, "主播_P1.mp4"));
    expect(existsSync(out)).toBe(true);
    expect(readdirSync(dir)).toContain("主播_2026-09-12_x.mp4"); // 规范名不动
    // 硬链接:同 inode → 不额外占盘(内容相同即证明)
    expect(statSync(out).ino).toBe(statSync(canonical).ino);
  });

  it("desiredTitle 为空/清洗后为空 → 返回 canonical(不改名)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "a.mp4");
    writeFileSync(canonical, "x");
    expect(prepareUploadAlias(dir, "plain", canonical, null)).toBe(canonical);
    expect(prepareUploadAlias(dir, "plain", canonical, "")).toBe(canonical);
    expect(prepareUploadAlias(dir, "plain", canonical, "!!!")).toBe(canonical);
    expect(existsSync(join(dir, UPLOAD_ALIAS_DIR))).toBe(false); // 没建任何目录
  });

  it("重复调用(续跑)覆盖旧别名,不报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "a.mp4");
    writeFileSync(canonical, "x");
    const first = prepareUploadAlias(dir, "plain", canonical, "标题P1");
    const second = prepareUploadAlias(dir, "plain", canonical, "标题P1");
    expect(second).toBe(first);
    expect(existsSync(second)).toBe(true);
  });

  it("标题含非法文件名字符 → 清洗后落盘", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "a.mp4");
    writeFileSync(canonical, "x");
    const out = prepareUploadAlias(dir, "plain", canonical, "主播/第1场:part");
    expect(existsSync(out)).toBe(true);
    expect(out).toContain("主播-第1场-part");
  });
});
