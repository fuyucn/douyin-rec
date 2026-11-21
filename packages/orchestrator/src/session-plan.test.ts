import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePartAliasStem } from "@drec/core";
import { deriveSegmentPlan, deriveStageProducts, prepareUploadAlias, repairStageProductsByAlias, restoreProductFromAlias, segmentStem, sessionBaseOfFile, sessionBasesOfFiles, UPLOAD_ALIAS_DIR } from "./session-plan.js";

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

  it("清洗后同名的长标题仍拿到不同别名(后缀不会被二次截断)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "a.mp4");
    writeFileSync(canonical, "x");
    const used = new Set<string>();
    const first = resolvePartAliasStem("a".repeat(70) + "/x", 1, used)!;
    const second = resolvePartAliasStem("a".repeat(70) + ":x", 2, used)!;
    const out1 = prepareUploadAlias(dir, "plain", canonical, first.stem);
    const out2 = prepareUploadAlias(dir, "plain", canonical, second.stem);
    expect(out1).not.toBe(out2);
    expect(out2.split("/").pop()!.length).toBeLessThanOrEqual(64); // 60-char stem + ".mp4"
    expect(out2.endsWith("-P2.mp4")).toBe(true);
  });
});

describe("prepareUploadAlias:别名清单(恢复的唯一证据)", () => {
  it("建别名时记下 src/size,同一 src 只留最新一条", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-map-"));
    const canonical = join(dir, "主播_2026-11-21.mp4");
    writeFileSync(canonical, "plain-bytes");
    prepareUploadAlias(dir, "plain", canonical, "P1");
    prepareUploadAlias(dir, "plain", canonical, "Q1"); // 换模板后的第二个别名
    const map = JSON.parse(readFileSync(join(dir, UPLOAD_ALIAS_DIR, ".aliases.json"), "utf8")) as Record<string, { src: string; size: number }>;
    expect(map["Q1.mp4"]).toEqual({ src: "主播_2026-11-21.mp4", size: 11, at: expect.any(Number) });
    expect(map["P1.mp4"]).toBeUndefined(); // 同一 src 只留最新
  });

  it("未配分P模板(desiredTitle 为空)→ 不建目录、不写清单", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-nomap-"));
    const canonical = join(dir, "a.mp4");
    writeFileSync(canonical, "x");
    prepareUploadAlias(dir, "plain", canonical, null);
    expect(existsSync(join(dir, UPLOAD_ALIAS_DIR))).toBe(false);
  });
});

describe("restoreProductFromAlias(只认清单,不猜文件名)", () => {
  /** 建一场 stage:plain + danmu,并给两者建别名(真实路径,含清单)。 */
  const seed = (): { dir: string; plain: string; danmu: string } => {
    const dir = mkdtempSync(join(tmpdir(), "alias-restore-"));
    const dateName = "主播_2026-11-21";
    const plain = join(dir, `${dateName}.mp4`);
    const danmu = join(dir, `${dateName}_danmu.mp4`);
    writeFileSync(plain, "plain-bytes");
    writeFileSync(danmu, "danmu-bytes");
    prepareUploadAlias(dir, "plain", plain, "P1");
    prepareUploadAlias(dir, "danmu", danmu, "P2_danmu");
    return { dir, plain, danmu };
  };

  it("规范名被手删、清单命中且大小一致 → rename 零拷贝恢复(原位别名消失,内容不变)", () => {
    const { dir, danmu } = seed();
    const alias = join(dir, UPLOAD_ALIAS_DIR, "P2_danmu.mp4");
    const aliasIno = statSync(alias).ino;
    rmSync(danmu);
    const logs: string[] = [];
    expect(restoreProductFromAlias(danmu, (m) => logs.push(m))).toBe(true);
    expect(existsSync(danmu)).toBe(true);
    expect(statSync(danmu).ino).toBe(aliasIno); // 同一个 inode:没有复制
    expect(existsSync(alias)).toBe(false);      // rename 后原位名字消失
    expect(readFileSync(danmu, "utf8")).toBe("danmu-bytes");
    expect(logs.join("\n")).toContain("零拷贝恢复");
    // 清单里那条已被消费
    const map = JSON.parse(readFileSync(join(dir, UPLOAD_ALIAS_DIR, ".aliases.json"), "utf8")) as Record<string, unknown>;
    expect(map["P2_danmu.mp4"]).toBeUndefined();
  });

  it("没有清单(老目录 / 手放的别名)→ 不猜,保持原判定", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-noguess-"));
    writeFileSync(join(dir, "主播_2026-11-21.mp4"), "p");
    mkdirSync(join(dir, UPLOAD_ALIAS_DIR), { recursive: true });
    writeFileSync(join(dir, UPLOAD_ALIAS_DIR, "P2_danmu.mp4"), "whatever"); // 清单不存在
    const canonical = join(dir, "主播_2026-11-21_danmu.mp4");
    expect(restoreProductFromAlias(canonical)).toBe(false);
    expect(existsSync(canonical)).toBe(false);
  });

  it("清单命中但大小不符(别名已被别的内容替换)→ 不恢复", () => {
    const { dir, danmu } = seed();
    writeFileSync(join(dir, UPLOAD_ALIAS_DIR, "P2_danmu.mp4"), "short"); // 覆盖别名,size 变了
    rmSync(danmu);
    const logs: string[] = [];
    expect(restoreProductFromAlias(danmu, (m) => logs.push(m))).toBe(false);
    expect(existsSync(danmu)).toBe(false);
    expect(logs.join("\n")).toContain("不一致");
  });

  it("清单命中但别名已不存在 → 不恢复(没有第二份数据)", () => {
    const { dir, danmu } = seed();
    rmSync(join(dir, UPLOAD_ALIAS_DIR, "P2_danmu.mp4"));
    rmSync(danmu);
    expect(restoreProductFromAlias(danmu)).toBe(false);
  });

  it("plain 标题以 `_danmu` 结尾(与弹幕别名同名)→ 不会把 plain 内容当成 P2 恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-tail-"));
    const dateName = "主播_2026-11-21";
    const plain = join(dir, `${dateName}.mp4`);
    const danmu = join(dir, `${dateName}_danmu.mp4`);
    writeFileSync(plain, "plain-bytes");
    writeFileSync(danmu, "danmu-bytes");
    // 模板让 plain 的分P名也以 _danmu 结尾:别名文件叫 P1_danmu.mp4,但清单 src 是 plain
    prepareUploadAlias(dir, "plain", plain, "P1_danmu");
    rmSync(danmu);
    expect(restoreProductFromAlias(danmu)).toBe(false);  // 清单里没有 src=danmu 的条目
    expect(existsSync(danmu)).toBe(false);
    rmSync(plain);
    expect(restoreProductFromAlias(plain)).toBe(true);   // 但 plain 自己能恢复
  });
});

describe("repairStageProductsByAlias(整场找回)", () => {
  it("danmu + livechat 规范名被删 → 两个都恢复,plain 在则不动", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-repair-all-"));
    const dateName = "主播_2026-11-21";
    const plain = join(dir, `${dateName}.mp4`);
    const danmu = join(dir, `${dateName}_danmu.mp4`);
    const livechat = join(dir, `${dateName}_livechat.mp4`);
    for (const [p, body] of [[plain, "p-bytes"], [danmu, "d-bytes"], [livechat, "l-bytes"]] as const) writeFileSync(p, body);
    prepareUploadAlias(dir, "plain", plain, "P1");
    prepareUploadAlias(dir, "danmu", danmu, "P2_danmu");
    prepareUploadAlias(dir, "livechat", livechat, "P3_livechat");
    const plainIno = statSync(plain).ino;
    rmSync(danmu); rmSync(livechat);
    const logs: string[] = [];
    expect(repairStageProductsByAlias(dir, "mp4", (m) => logs.push(m))).toEqual([danmu, livechat]);
    expect(readFileSync(danmu, "utf8")).toBe("d-bytes");
    expect(readFileSync(livechat, "utf8")).toBe("l-bytes");
    expect(statSync(plain).ino).toBe(plainIno); // plain 未被碰过
    expect(logs.length).toBe(2);
  });

  it("什么都齐全 → 空数组(不产生日志、不动任何文件)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-repair-clean-"));
    const dateName = "主播_2026-11-21";
    writeFileSync(join(dir, `${dateName}.mp4`), "p");
    writeFileSync(join(dir, `${dateName}_danmu.mp4`), "d");
    prepareUploadAlias(dir, "danmu", join(dir, `${dateName}_danmu.mp4`), "P2_danmu");
    const logs: string[] = [];
    expect(repairStageProductsByAlias(dir, "mp4", (m) => logs.push(m))).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("repairStageProductsByAlias:规范名全丢时的 stemHint 兜底", () => {
  it("deriveStageProducts 推不出 dateName 时,用台账 stem 恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-hint-"));
    const dateName = "主播_2026-11-21";
    writeFileSync(join(dir, `${dateName}.mp4`), "p-bytes");
    writeFileSync(join(dir, `${dateName}_danmu.mp4`), "d-bytes");
    prepareUploadAlias(dir, "plain", join(dir, `${dateName}.mp4`), "P1");
    prepareUploadAlias(dir, "danmu", join(dir, `${dateName}_danmu.mp4`), "P2_danmu");
    rmSync(join(dir, `${dateName}.mp4`));        // 两个规范名都被手删
    rmSync(join(dir, `${dateName}_danmu.mp4`));
    const logs: string[] = [];
    const repaired = repairStageProductsByAlias(dir, "mp4", (m) => logs.push(m), { stemHint: dateName });
    expect(repaired.sort()).toEqual([join(dir, `${dateName}.mp4`), join(dir, `${dateName}_danmu.mp4`)].sort());
    expect(readFileSync(join(dir, `${dateName}_danmu.mp4`), "utf8")).toBe("d-bytes");
  });

  it("没有 stemHint 又推不出 dateName → 不动(保持转人工)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-nohint-"));
    const dateName = "主播_2026-11-21";
    writeFileSync(join(dir, `${dateName}.mp4`), "p");
    prepareUploadAlias(dir, "plain", join(dir, `${dateName}.mp4`), "P1");
    rmSync(join(dir, `${dateName}.mp4`));
    expect(repairStageProductsByAlias(dir, "mp4")).toEqual([]);
  });
});
