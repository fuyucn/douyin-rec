import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UploadGate } from "@drec/core";
import { RollingUploader, type RollingUploaderOpts } from "../../packages/app/src/rolling-upload.js";
import { ANCHOR, ROOM, Scenario } from "./harness/scenario.js";
import { pastStartMs, sessionBaseOf, writeRecording } from "./harness/fake-recordings.js";

let s: Scenario;
afterEach(() => s?.dispose());

const SEG_SEC = 600;
const gate = (): UploadGate => new UploadGate({ rateLimit: 1000, sleep: async () => {}, warn: () => {} });
const dir = (): string => join(s.recordingsDir, ANCHOR);

/** 录制端「新开一段」:写文件(JSON 占位)+ 把 mtime 定到该段结束时刻(封口/碎片判定看 mtime)。 */
function writeSegment(startMs: number, idx: number): string {
  const base = sessionBaseOf(ANCHOR, startMs);
  const p = join(dir(), `${base}_${String(idx).padStart(3, "0")}.ts`);
  writeFileSync(p, JSON.stringify({ durationSec: SEG_SEC, startMs: startMs + idx * SEG_SEC * 1000 }));
  const t = (startMs + (idx + 1) * SEG_SEC * 1000) / 1000;
  utimesSync(p, t, t);
  return p;
}

function uploader(logs: string[], over: Partial<RollingUploaderOpts> = {}): RollingUploader {
  return new RollingUploader({
    room: { platform: "douyin", roomSlug: ROOM },
    uploadMeta: { tag: "直播,录像", tid: 21, desc: "e2e" },
    cookies: join(s.root, "cookies.json"),
    gate: gate(),
    log: (m) => logs.push(m),
    uploadPlainRaw: (o) => s.fake.uploadPlain(o.plain),
    appendGroupRaw: (o) => s.fake.appendGroup(o),
    countPartsRaw: (bv) => s.fake.countVideoParts(bv),
    ...over,
  });
}

/** 录制端写会话 sidecar(xml/session.json),与真实录制一致(先于分段,结束后仍在)。 */
function writeSidecars(startMs: number): { xmlPath: string; sessionJson: string; base: string } {
  const [w] = writeRecording({ recordingsDir: s.recordingsDir, anchor: ANCHOR, roomSlug: ROOM, sessions: [{ startMs, segments: 0, segSec: SEG_SEC }] });
  s.sessions.push(w!);
  return w!;
}
const readRolling = (base: string): { bv?: string; confirmed: number[]; ambiguous?: number[]; uploading?: { index: number; kind: string } } =>
  JSON.parse(readFileSync(join(dir(), `${base}.rolling.json`), "utf-8"));

/** 把一场录完:边录边上报分段 + flush,最后收尾。 */
async function recordSession(u: RollingUploader, startMs: number, segments: number): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < segments; i++) {
    const p = writeSegment(startMs, i);
    files.push(p);
    u.noteSegment(p);
    if (i < segments - 1) await u.flush({ recordingActive: true });
  }
  await u.flush({ recordingActive: false });
  return files;
}

describe("e2e: rolling(边录边传)", () => {
  it("录完 → 录制端自己建稿/追加/删确认段;master 收口 done 且不重复建稿", async () => {
    s = await Scenario.create();
    const start = pastStartMs(0, 10, 0);
    const side = writeSidecars(start);
    const logs: string[] = [];
    const files = await recordSession(uploader(logs), start, 4);

    // 录制端:一份稿、4 个分 P、确认段的源已删。
    expect(s.fake.draftCount).toBe(1);
    expect(s.fake.onlyArchive.parts).toHaveLength(4);
    for (const f of files) expect(existsSync(f), `确认后应删源 ${f}`).toBe(false);

    // master 收口:识别 rolling.bv → 直接 done,不再建稿/不 pull。
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("done");
    expect(s.ledger.get(key)?.bv).toBe(s.fake.onlyArchive.bv);
    expect(s.fake.draftCount, "master 不得重复建稿").toBe(1);
    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(s.ledgerRejections()).toEqual([]);
    expect(existsSync(side.xmlPath)).toBe(true);
    expect(existsSync(side.sessionJson)).toBe(true);
    expect(s.stageResidue()).toEqual([]);
    expect(s.notifications.some((n) => n.kind === "uploadDone")).toBe(true);
    void logs;
  });

  it("append 结果不确定且分P数不可查 → 转人工:保留未确认源、不重传、不重复建稿", async () => {
    s = await Scenario.create();
    const start = pastStartMs(0, 10, 0);
    writeSidecars(start);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    s.fake.countAvailable = false;
    const files = await recordSession(uploader([]), start, 4);

    const st = readRolling(sessionBaseOf(ANCHOR, start));
    expect(st.ambiguous).toEqual([1]);
    expect(s.fake.draftCount).toBe(1);
    // 头阻塞:P1 已确认被删;第 1 段起(含不确定段与其后)全部保留,绝不越过空洞继续追加。
    expect(existsSync(files[0]!)).toBe(false);
    for (const f of files.slice(1)) expect(existsSync(f), `未确认段应保留 ${f}`).toBe(true);
    expect(s.fake.calls.filter((c) => c.op === "append")).toHaveLength(1);

    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.ledger.get(key)?.error).toContain("不确定");
    expect(s.fake.draftCount, "master 不得补建稿").toBe(1);
    expect(s.ledgerRejections()).toEqual([]);
    // 再对账一轮:needs_manual 不被自动推进,也不触发任何新上传。
    const calls = s.fake.calls.length;
    await s.reconcile();
    expect(s.fake.calls).toHaveLength(calls);
  });

  it("append 已提交但响应丢失、分P数可查 → 识别为成功,不重复追加", async () => {
    s = await Scenario.create();
    const start = pastStartMs(0, 10, 0);
    writeSidecars(start);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    await recordSession(uploader([]), start, 3);
    expect(s.fake.onlyArchive.parts).toHaveLength(3);
    expect(readRolling(sessionBaseOf(ANCHOR, start)).ambiguous ?? []).toEqual([]);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
  });

  // ── 已知缺陷 #46:重启后旧会话未确认分段被孤立 ──────────────────────────────────
  // 现状:旧会话 append 进行中进程被杀,rolling.json 留着 `uploading` 标记;重启后只会为**新会话**
  // 创建上传器,旧会话的标记永远没人结算,其后分段既不续传也不转人工、无日志。
  // 预期失败(it.fails):待 #46 修复(启动时扫描并接管/转人工)后,本用例会开始通过 → 去掉 `.fails`。
  describe("重启后孤立分段(已知缺陷 https://github.com/fuyucn/douyin-rec/issues/46)", () => {
    async function crashMidAppend(): Promise<{ oldStart: number; oldFiles: string[]; oldBase: string }> {
      const oldStart = pastStartMs(0, 10, 0);
      const oldBase = sessionBaseOf(ANCHOR, oldStart);
      writeSidecars(oldStart);
      // append 永不返回 = 进程在「上传中」被杀;随后整个进程内存态丢弃(不再 flush 旧上传器)。
      const u = uploader([], { appendGroupRaw: () => new Promise<void>(() => {}) });
      const files: string[] = [];
      for (let i = 0; i < 3; i++) { const p = writeSegment(oldStart, i); files.push(p); u.noteSegment(p); }
      void u.flush({ recordingActive: true }); // 段0建稿;段1 append 挂起
      await new Promise((r) => setTimeout(r, 50));
      return { oldStart, oldFiles: files, oldBase };
    }

    it("现状护栏:被孤立的旧段源文件不会被删(不丢数据)", async () => {
      s = await Scenario.create();
      const { oldFiles, oldBase } = await crashMidAppend();
      expect(readRolling(oldBase).uploading).toMatchObject({ kind: "append" });
      await s.restart();
      expect(existsSync(oldFiles[0]!), "段0已确认应已删").toBe(false);
      expect(existsSync(oldFiles[1]!)).toBe(true);
      expect(existsSync(oldFiles[2]!)).toBe(true);
    });

    it.fails("重启开新会话后,旧会话的未确认分段被接管:uploading 标记已结算、每段要么已确认要么转人工", async () => {
      s = await Scenario.create();
      const { oldBase } = await crashMidAppend();
      await s.restart();
      // 重启后:录制端只为「新会话」创建上传器并正常录完。
      const newStart = pastStartMs(0, 11, 0);
      writeSidecars(newStart);
      await recordSession(uploader([]), newStart, 2);

      const old = readRolling(oldBase);
      const settled = new Set([...(old.confirmed ?? []), ...(old.ambiguous ?? [])]);
      expect(old.uploading, "旧会话的 uploading 标记应被结算").toBeUndefined();
      for (const i of [0, 1, 2]) expect(settled.has(i), `旧会话段 ${i} 既未确认也未转人工(被孤立)`).toBe(true);
    });
  });

  // ── #57 R1 主控止血:建稿中被杀、无稿件号 → 主控绝不走常规整场管线(否则重复建稿),转人工 ──────
  // 注:这是「主控判定」收紧;录制端重启后接管孤立分段(#46)属 R2,上面的 it.fails 仍保持预期失败。
  describe("建稿中被杀(#57 R1)", () => {
    async function crashMidCreate(): Promise<{ base: string; files: string[] }> {
      const start = pastStartMs(0, 10, 0);
      writeSidecars(start);
      // 建稿(create)永不返回 = 进程在「建稿中」被杀:意图标记已落盘,稿件号没有。
      const u = uploader([], { uploadPlainRaw: () => new Promise(() => {}) });
      const files: string[] = [];
      for (let i = 0; i < 2; i++) { const p = writeSegment(start, i); files.push(p); u.noteSegment(p); }
      void u.flush({ recordingActive: false });
      await new Promise((r) => setTimeout(r, 50));
      return { base: sessionBaseOf(ANCHOR, start), files };
    }

    it("无稿件号 + uploading=create → 主控转人工,不建稿、不 pull、不删源、通知", async () => {
      s = await Scenario.create();
      const { base, files } = await crashMidCreate();
      const st = readRolling(base);
      expect(st.bv).toBeUndefined();
      expect(st.uploading).toMatchObject({ kind: "create" });
      await s.restart();

      await s.reconcile();
      const key = s.onlyKey();
      expect(s.jobState(key)).toBe("needs_manual");
      expect(s.ledger.get(key)?.error).toContain("无稿件号");
      expect(s.fake.draftCount, "主控不得走常规管线建稿").toBe(0);
      expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(0);
      for (const f of files) expect(existsSync(f), `源必须保留 ${f}`).toBe(true);
      expect(s.notifications.some((n) => n.kind === "error" && String((n as { message?: string }).message).includes("无稿件号"))).toBe(true);
      expect(s.ledgerRejections()).toEqual([]);
      // 再对账:needs_manual 不被自动推进。
      await s.reconcile();
      expect(s.fake.draftCount).toBe(0);
    });
  });
});
