// packages/orchestrator/src/scan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRecordings, scanRollingSessions } from "./scan.js";

describe("scanRecordings", () => {
  it("聚合会话分段时长 + 读 gaps + 映射 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "一勺小苏打"); mkdirSync(dir);
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_000.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_001.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54.gaps.json"),
      JSON.stringify({ sessionBase: "一勺小苏打_2026-06-27_07-54", gaps: [{ startMs: 0, endMs: 10_000 }], totalGapSec: 10 }));

    const recordings = await scanRecordings(
      root,
      { "一勺小苏打": "999" },
      async () => ({ durationSec: 1800, startMs: 1_700_000_000_000, endMs: 1_700_001_800_000 }),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].roomSlug).toBe("999");
    expect(recordings[0].durationSec).toBe(3600); // 两段 1800 各
    expect(recordings[0].totalGapSec).toBe(10);
    expect(recordings[0].startMs).toBe(1_700_000_000_000);
    expect(recordings[0].endMs).toBe(1_700_001_800_000);
  });

  it("totalBytes = 本场所有 .ts 的字节数之和(issue #25 ①);无 ts 的会话不上报", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播B"); mkdirSync(dir);
    writeFileSync(join(dir, "主播B_2026-06-27_09-00_000.ts"), Buffer.alloc(1000));
    writeFileSync(join(dir, "主播B_2026-06-27_09-00_001.ts"), Buffer.alloc(2500));
    // 另一场:ts 已被边录边传删空,只剩 rolling.json(带 bv)
    writeFileSync(join(dir, "主播B_2026-06-27_12-00.rolling.json"), JSON.stringify({ bv: "BV1X", parts: [] }));
    const rs = await scanRecordings(root, {}, async () => ({ durationSec: 10, startMs: 1_700_000_000_000, endMs: 1_700_000_010_000 }));
    const withTs = rs.find((r) => r.tsFiles.length === 2)!;
    expect(withTs.totalBytes).toBe(3500);
    const noTs = rs.find((r) => r.tsFiles.length === 0);
    if (noTs) expect(noTs.totalBytes).toBeUndefined();
  });

  it("未命中 taskRooms 时 fallback 使用目录名作 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");

    const recordings = await scanRecordings(
      root,
      {}, // empty — no mapping
      async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 }),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].roomSlug).toBe("主播A"); // directory name as fallback
  });

  it("弹幕源 .xml 是可选的:不存在时不挂 xmlPath(避免 pull 一个不存在文件而整场失败)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");

    const without = await scanRecordings(root, {}, async () => ({ durationSec: 60, startMs: 1, endMs: 2 }));
    expect(without[0].xmlPath).toBeUndefined();

    writeFileSync(join(dir, "主播A_2026-06-27_08-00.xml"), "<i/>");
    const withXml = await scanRecordings(root, {}, async () => ({ durationSec: 60, startMs: 1, endMs: 2 }));
    expect(withXml[0].xmlPath).toBe(join(dir, "主播A_2026-06-27_08-00.xml"));
  });

  it("danmuCount:数 <d>/<gift>/<member>;仅表头的空 xml → 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");
    writeFileSync(
      join(dir, "主播A_2026-06-27_08-00.xml"),
      `<?xml version="1.0"?><i><metadata><video_start_time>0</video_start_time></metadata>` +
        `<d p="1,1,25,16777215,1000,0,u,1,0" user="a">hi</d>` +
        `<d p="2,1,25,16777215,2000,0,u,1,0" user="b">yo</d>` +
        `<gift user="a" ts="3000"/>` +
        `<member user="c" ts="4000"/>` +
        `</i>`,
    );
    const r = await scanRecordings(root, {}, async () => ({ durationSec: 60, startMs: 1, endMs: 2 }));
    expect(r[0].danmuCount).toBe(4); // 2 d + 1 gift + 1 member
  });

  it("danmuCount:仅表头(只有样式表,无消息)→ 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");
    // 表头 + 样式表(含 <html>/<style> 等,但无 <d /<gift /<member)
    writeFileSync(
      join(dir, "主播A_2026-06-27_08-00.xml"),
      `<i><metadata><video_start_time>1791437768885</video_start_time></metadata>` +
        `<RecorderXmlStyle><z:stylesheet><html><style>body{margin:0}</style></html></z:stylesheet></RecorderXmlStyle></i>`,
    );
    const r = await scanRecordings(root, {}, async () => ({ durationSec: 60, startMs: 1, endMs: 2 }));
    expect(r[0].danmuCount).toBe(0);
  });

  it("danmuCount:无 xml → 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");
    const r = await scanRecordings(root, {}, async () => ({ durationSec: 60, startMs: 1, endMs: 2 }));
    expect(r[0].danmuCount).toBe(0);
  });

  it("recordings 目录不存在时返回空数组（不抛异常）", async () => {
    const recordings = await scanRecordings(
      "/does/not/exist",
      {},
      async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    );
    expect(recordings).toHaveLength(0);
  });

  it("多主播多会话各自独立返回", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dirA = join(root, "主播A"); mkdirSync(dirA);
    writeFileSync(join(dirA, "主播A_2026-06-27_08-00_000.ts"), "x");
    const dirB = join(root, "主播B"); mkdirSync(dirB);
    writeFileSync(join(dirB, "主播B_2026-06-27_09-00_000.ts"), "x");

    const recordings = await scanRecordings(
      root,
      { "主播A": "111", "主播B": "222" },
      async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 }),
    );

    expect(recordings).toHaveLength(2);
    const slugs = recordings.map((r) => r.roomSlug).sort();
    expect(slugs).toEqual(["111", "222"]);
  });

  it("issue #143:边车存在时填 sessionJsonPath(随 pull 进 stage);缺失则不填(老录像/旧行为)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    const withSc = "主播A_2026-06-27_08-00-00", noSc = "主播A_2026-06-27_09-00-00";
    writeFileSync(join(dir, `${withSc}.mkv`), "x");
    writeFileSync(join(dir, `${withSc}.session.json`), JSON.stringify({ roomSlug: "888", platform: "douyin", nodeFormat: "mkv" }));
    writeFileSync(join(dir, `${noSc}.ts`), "x");
    const recs = await scanRecordings(root, {}, async () => ({ durationSec: 1, startMs: 0, endMs: 1 }));
    const a = recs.find((r) => r.sessionBase === withSc)!;
    const b = recs.find((r) => r.sessionBase === noSc)!;
    expect(a.tsFiles).toEqual([join(dir, `${withSc}.mkv`)]);
    expect(a.sessionJsonPath).toBe(join(dir, `${withSc}.session.json`));
    expect("sessionJsonPath" in b).toBe(false);
  });

  it("T-33:段被删空但留下 .rolling.json → 仍产出(带 rolling.bv),供 master 收口", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    // 边录边传:各段确认后已被删,只剩 session sidecar + rolling sidecar + xml。
    writeFileSync(join(dir, "主播A_2026-06-27_08-00-00.session.json"),
      JSON.stringify({ sessionBase: "主播A_2026-06-27_08-00-00", roomSlug: "888", platform: "douyin" }));
    writeFileSync(join(dir, "主播A_2026-06-27_08-00-00.xml"), "x");
    writeFileSync(join(dir, "主播A_2026-06-27_08-00-00.rolling.json"),
      JSON.stringify({ bv: "BV1rollingX", confirmed: [0, 1], ambiguous: [] }));

    const recordings = await scanRecordings(root, {}, async () => ({ durationSec: 0, startMs: 0, endMs: 0 }));
    expect(recordings).toHaveLength(1);
    expect(recordings[0].roomSlug).toBe("888");
    expect(recordings[0].tsFiles).toEqual([]);
    expect(recordings[0].rolling?.bv).toBe("BV1rollingX");
    expect(recordings[0].rolling?.confirmed).toEqual([0, 1]);
    // startMs 从会话 base 时间戳兜底(不是 0,否则聚类算出 1970-01-01 的 streamKey)。
    expect(recordings[0].startMs).toBe(new Date(2026, 5, 27, 8, 0, 0).getTime());
  });

  it("T-33:无 rolling.json 且无 ts 的目录不产出(不误报空会话)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00-00.xml"), "x"); // 只有 xml,无 ts 无 rolling
    const recordings = await scanRecordings(root, {}, async () => ({ durationSec: 0, startMs: 0, endMs: 0 }));
    expect(recordings).toHaveLength(0);
  });

  it("#57 R1:完整透传边传进度(含 uploading 意图);非法形状/旧文件缺字段按缺省", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    const put = (base: string, rolling: unknown): void => {
      writeFileSync(join(dir, `${base}.ts`), "x");
      writeFileSync(join(dir, `${base}.rolling.json`), JSON.stringify(rolling));
    };
    put("主播A_2026-06-27_08-00-00", { confirmed: [], uploading: { index: 0, kind: "create" } });
    put("主播A_2026-06-27_09-00-00", { bv: "BV1x", confirmed: [0], uploading: { index: 1, kind: "append" } });
    put("主播A_2026-06-27_10-00-00", { bv: "BV1y", confirmed: [0] }); // 旧节点:无 uploading
    put("主播A_2026-06-27_11-00-00", { confirmed: [], uploading: { index: "0", kind: "weird" } }); // 非法
    const recs = await scanRecordings(root, {}, async () => ({ durationSec: 1, startMs: 1, endMs: 2 }));
    const by = (h: string) => recs.find((r) => r.sessionBase.includes(`_${h}-`))!.rolling!;
    expect(by("08").uploading).toEqual({ index: 0, kind: "create" });
    expect(by("08").bv).toBeUndefined();
    expect(by("09").uploading).toEqual({ index: 1, kind: "append" });
    expect(by("10").uploading).toBeUndefined();
    expect(by("11").uploading).toBeUndefined();
  });

  it("#57 R1:无 ts、无 bv 但留有建稿意图 → 仍产出(主控才能转人工)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00-00.rolling.json"),
      JSON.stringify({ confirmed: [], uploading: { index: 0, kind: "create" } }));
    const recs = await scanRecordings(root, {}, async () => ({ durationSec: 0, startMs: 0, endMs: 0 }));
    expect(recs).toHaveLength(1);
    expect(recs[0].rolling?.uploading?.kind).toBe("create");
  });
});

describe("scanRollingSessions(F1:边录边传实时进度,只读 sidecar)", () => {
  const mk = (root: string, anchor: string, base: string, rolling: object, session: object | null = { roomSlug: "777", platform: "douyin" }): void => {
    const dir = join(root, anchor); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}.rolling.json`), JSON.stringify(rolling));
    if (session) writeFileSync(join(dir, `${base}.session.json`), JSON.stringify(session));
  };
  const seg = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, path: `/x/${i}.ts` }));
  const active = [{ platform: "douyin", roomSlug: "777" }];

  it("在录房间的最新会话:带 BV / 已确认数 / 总段数 / recording=true", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    mk(root, "A", "A_2026-10-15_03-00-00", { segments: seg(9), confirmed: [0, 1, 2, 3, 4, 5, 6, 7], bv: "BV1X", startMs: 2000 });
    const r = scanRollingSessions(root, active);
    expect(r).toEqual([{ platform: "douyin", roomSlug: "777", sessionBase: "A_2026-10-15_03-00-00", bv: "BV1X", confirmed: 8, total: 9, ambiguous: 0, uploading: undefined, lockedBytes: 0, recording: true }]);
  });

  it("lockedBytes = 序号不在 confirmed 且文件仍在的分段字节之和;已确认/已删的不算", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    const dir = join(root, "A"); mkdirSync(dir);
    writeFileSync(join(dir, "s0.ts"), Buffer.alloc(100)); // 已确认但文件还在(尚未删):不算
    writeFileSync(join(dir, "s1.ts"), Buffer.alloc(300)); // 未确认:算
    writeFileSync(join(dir, "s2.ts"), Buffer.alloc(50));  // 未确认:算
    // s3 未确认但文件已不存在:不算
    const segments = [0, 1, 2, 3].map((i) => ({ index: i, path: join(dir, `s${i}.ts`) }));
    mk(root, "A", "A_lock", { segments, confirmed: [0], bv: "BV1", startMs: 1 });
    expect(scanRollingSessions(root, active)[0]!.lockedBytes).toBe(350);
  });

  it("同房间旧会话(已收口、无未决项)不纳入;只认在录房间的最新会话", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    mk(root, "A", "A_old", { segments: seg(3), confirmed: [0, 1, 2], bv: "BVOLD", startMs: 1000 });
    mk(root, "A", "A_new", { segments: seg(2), confirmed: [0], bv: "BVNEW", startMs: 2000 });
    expect(scanRollingSessions(root, active).map((s) => s.sessionBase)).toEqual(["A_new"]);
  });

  it("房间不在录 + 无未决项 → 不纳入;不在录但有 ambiguous / uploading → 纳入(收播后仍需关注)", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    mk(root, "A", "A_done", { segments: seg(2), confirmed: [0, 1], bv: "BV1", startMs: 1 });
    mk(root, "B", "B_amb", { segments: seg(3), confirmed: [0], ambiguous: [1], bv: "BV2", startMs: 1 }, { roomSlug: "888", platform: "douyin" });
    mk(root, "C", "C_up", { segments: seg(1), confirmed: [], uploading: { index: 0, kind: "create" }, startMs: 1 }, { roomSlug: "999", platform: "douyin" });
    const r = scanRollingSessions(root, []);
    expect(r.map((s) => s.sessionBase).sort()).toEqual(["B_amb", "C_up"]);
    expect(r.find((s) => s.sessionBase === "B_amb")).toMatchObject({ ambiguous: 1, recording: false, bv: "BV2" });
    expect(r.find((s) => s.sessionBase === "C_up")).toMatchObject({ uploading: { index: 0, kind: "create" }, bv: undefined });
  });

  it("损坏 sidecar / 无房间身份 → 跳过,绝不抛;目录不存在 → []", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    mkdirSync(join(root, "A"));
    writeFileSync(join(root, "A", "bad.rolling.json"), "{not json");
    mk(root, "B", "B_nosess", { segments: seg(1), confirmed: [], startMs: 1 }, null);
    expect(scanRollingSessions(root, active)).toEqual([]);
    expect(scanRollingSessions(join(root, "nope"), active)).toEqual([]);
  });

  it("同 roomSlug 不同平台互不误判在录", () => {
    const root = mkdtempSync(join(tmpdir(), "rs-"));
    mk(root, "A", "A_bili", { segments: seg(1), confirmed: [0], startMs: 5 }, { roomSlug: "777", platform: "bilibili" });
    expect(scanRollingSessions(root, [{ platform: "douyin", roomSlug: "777" }])).toEqual([]);
  });
});
