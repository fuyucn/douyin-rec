import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UploadGate } from "@drec/core";
import { RollingUploader, type RollingUploaderOpts } from "../../packages/app/src/rolling-upload.js";
import { takeoverScanRoots } from "../../packages/app/src/rolling-takeover.js";
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
const readRolling = (base: string): { schemaVersion?: number; bv?: string; confirmed: number[]; ambiguous?: number[]; uploading?: { index: number; kind: string }; intent?: { kind: string; index: number }; lease?: { pid: number } } =>
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

  // ── #46 / #57 R2:重启后接管遗留会话 ───────────────────────────────────────────────
  // 旧会话 append 进行中进程被杀 → 清单留着 `intent`/`uploading` 与租约;重启后新会话加入第一段时扫描
  // 兄弟清单:租约已死 → 回读核对 → 续传到已有稿件号(只 append,绝不建稿)或转人工(必须日志 + 通知)。
  describe("重启后接管遗留会话(#46 / #57 R2)", () => {
    /** 回读间隔注入 0 + 睡眠 no-op:接管流程里「≥3 分钟间隔」的等待在测试里瞬时完成,但调用次数可断言。 */
    const fast = (sleeps: number[] = []): Partial<RollingUploaderOpts> => ({
      readbackGapMs: 180_000,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    /**
     * 旧会话:3 段,段 0 建稿并确认(源已删),段 1 append 时进程被杀。`committed` = 被杀前服务端是否已提交。
     * 「被杀」= 旧实例 abandon(心跳停止、退出存活表、租约原样留盘);之后整个进程内存态丢弃。
     */
    async function crashMidAppend(committed = false): Promise<{ oldStart: number; oldFiles: string[]; oldBase: string }> {
      const oldStart = pastStartMs(0, 10, 0);
      const oldBase = sessionBaseOf(ANCHOR, oldStart);
      writeSidecars(oldStart);
      const u = uploader([], {
        appendGroupRaw: async (o) => {
          if (committed) await s.fake.appendGroup(o); // 服务端已提交,但客户端没等到响应就被杀
          await new Promise<void>(() => {});
        },
      });
      const files: string[] = [];
      for (let i = 0; i < 3; i++) { const p = writeSegment(oldStart, i); files.push(p); u.noteSegment(p); }
      void u.flush({ recordingActive: true }); // 段0建稿;段1 append 挂起
      await new Promise((r) => setTimeout(r, 50));
      u.abandon();
      return { oldStart, oldFiles: files, oldBase };
    }

    /** 重启后新会话开录(只上报第一段,触发兄弟扫描),返回接管完成信号。 */
    async function restartAndJoin(over: Partial<RollingUploaderOpts> = {}, logs: string[] = []): Promise<RollingUploader> {
      await s.restart();
      const newStart = pastStartMs(0, 11, 0);
      writeSidecars(newStart);
      const nu = uploader(logs, over);
      nu.noteSegment(writeSegment(newStart, 0));
      await nu.siblingTakeover;
      return nu;
    }

    it("现状护栏:被杀后旧段源文件不会被删(不丢数据),清单留意图与租约", async () => {
      s = await Scenario.create();
      const { oldFiles, oldBase } = await crashMidAppend();
      const st = readRolling(oldBase);
      expect(st.uploading).toMatchObject({ kind: "append" });
      expect(st).toMatchObject({ schemaVersion: 3, intent: { kind: "append", index: 1 }, lease: { pid: process.pid } });
      await s.restart();
      expect(existsSync(oldFiles[0]!), "段0已确认应已删").toBe(false);
      expect(existsSync(oldFiles[1]!)).toBe(true);
      expect(existsSync(oldFiles[2]!)).toBe(true);
    });

    it("重启开新会话后,旧会话被接管:两次稳定回读一致 → 续传到已有稿件号,稿件 3 个分P、不重复建稿", async () => {
      s = await Scenario.create();
      const { oldBase, oldFiles } = await crashMidAppend();
      const sleeps: number[] = [];
      const notes: string[] = [];
      await restartAndJoin({ ...fast(sleeps), notify: (_st, m) => notes.push(m) });

      const old = readRolling(oldBase);
      expect(old.uploading, "旧会话的 uploading 标记应被结算").toBeUndefined();
      expect(old.confirmed).toEqual([0, 1, 2]);
      expect(s.fake.draftCount, "接管全程不得建稿").toBe(1);
      expect(s.fake.onlyArchive.parts).toHaveLength(3);
      expect(sleeps, "两次回读之间必须等待 ≥ 注入的间隔").toEqual([180_000]);
      for (const f of oldFiles) expect(existsSync(f), `确认后补删 ${f}`).toBe(false);
      expect(notes, "未转人工 → 无告警").toEqual([]);
    });

    it("append 已提交后被杀:首次回读即 = 已确认数+1 → 补确认,不重复追加", async () => {
      s = await Scenario.create();
      const { oldBase } = await crashMidAppend(true);
      expect(s.fake.onlyArchive.parts).toHaveLength(2); // 段0 + 已提交的段1
      const sleeps: number[] = [];
      await restartAndJoin(fast(sleeps));
      const old = readRolling(oldBase);
      expect(old.confirmed).toEqual([0, 1, 2]);
      expect(s.fake.onlyArchive.parts, "段1 不得被重复追加").toHaveLength(3);
      expect(sleeps).toEqual([]);
    });

    it("append 被杀 + B站延迟:首读未同步、二读才可见 → 判定已提交,不重复追加", async () => {
      s = await Scenario.create();
      const { oldBase } = await crashMidAppend(true);
      let calls = 0;
      // 第一次回读时 B 站还没同步(只看到 1 个分P),之后才看到真实分P数。
      const delayed = async (bv: string): Promise<number | null> => {
        calls++;
        const real = await s.fake.countVideoParts(bv);
        return calls === 1 && real != null ? real - 1 : real;
      };
      // 注意:readback 第 1 次 = 已确认数(1)→ 必须等待后再读第 2 次(2 = 已确认+1)→ ack。
      await restartAndJoin({ ...fast(), countPartsRaw: delayed });
      expect(readRolling(oldBase).confirmed).toEqual([0, 1, 2]);
      expect(s.fake.onlyArchive.parts, "延迟可见的段1 不得被重复追加").toHaveLength(3);
    });

    it("回读异常(分P数对不上)→ 转人工:日志 + 通知、保留源、不续传、不建稿", async () => {
      s = await Scenario.create();
      const { oldBase, oldFiles } = await crashMidAppend();
      const notes: string[] = [];
      const logs: string[] = [];
      await restartAndJoin({ ...fast(), countPartsRaw: async () => 7, notify: (_st, m) => notes.push(m) }, logs);
      const old = readRolling(oldBase);
      expect(old.uploading).toBeUndefined();
      expect(old.ambiguous).toEqual([1]);
      expect(old.confirmed).toEqual([0]);
      expect(s.fake.draftCount).toBe(1);
      expect(s.fake.onlyArchive.parts).toHaveLength(1);
      expect(existsSync(oldFiles[1]!) && existsSync(oldFiles[2]!)).toBe(true);
      expect(notes.some((m) => m.includes("人工"))).toBe(true);
      expect(logs.some((m) => m.includes("需人工核对"))).toBe(true);
    });

    it("建稿中被杀(create 意图、无稿件号)→ 重启接管转人工:不重建稿、不续传,日志 + 通知", async () => {
      s = await Scenario.create();
      const start = pastStartMs(0, 10, 0);
      const base = sessionBaseOf(ANCHOR, start);
      writeSidecars(start);
      const u = uploader([], { uploadPlainRaw: () => new Promise(() => {}) }); // 建稿永不返回 = 被杀
      const files: string[] = [];
      for (let i = 0; i < 2; i++) { const p = writeSegment(start, i); files.push(p); u.noteSegment(p); }
      void u.flush({ recordingActive: false });
      await new Promise((r) => setTimeout(r, 50));
      u.abandon();
      const notes: string[] = [];
      await s.restart();
      const reports = await scanRoots([], notes);
      expect(reports.find((r) => r.base === base)?.outcome).toBe("manual");
      expect(readRolling(base).ambiguous).toEqual([0]);
      expect(readRolling(base).uploading).toBeUndefined();
      expect(s.fake.draftCount, "接管不得建稿").toBe(0);
      expect(s.fake.calls).toHaveLength(0);
      for (const f of files) expect(existsSync(f)).toBe(true);
      expect(notes.some((m) => m.includes("人工"))).toBe(true);
    });

    it("清单损坏 → 转人工:不动原文件、不当新会话、不建稿、通知;主控也转人工不走常规管线", async () => {
      s = await Scenario.create();
      const { oldBase, oldFiles } = await crashMidAppend();
      const manifest = join(dir(), `${oldBase}.rolling.json`);
      writeFileSync(manifest, '{"schemaVersion":3,"streamKey":"x","segs":[{"index":0,"pa'); // 写到一半被截断
      const before = readFileSync(manifest, "utf-8");
      const notes: string[] = [];
      const logs: string[] = [];
      // 走「服务启动扫描」路径(task serve 启动时对录像根目录扫一次)。
      await s.restart();
      const reports = await scanRoots(logs, notes);
      expect(reports.map((r) => r.outcome)).toContain("corrupt");

      expect(readFileSync(manifest, "utf-8"), "损坏文件原样保留(证据)").toBe(before);
      expect(s.fake.draftCount, "绝不重复建稿").toBe(1);
      expect(s.fake.calls.filter((c) => c.op === "append"), "接管不得续传").toHaveLength(0);
      expect(notes.some((m) => m.includes("损坏"))).toBe(true);
      expect(logs.some((m) => m.includes("损坏"))).toBe(true);
      for (const f of oldFiles.slice(1)) expect(existsSync(f)).toBe(true);

      await s.reconcile();
      const key = s.onlyKey();
      expect(s.jobState(key)).toBe("needs_manual");
      expect(s.ledger.get(key)?.error).toContain("损坏");
      expect(s.ledgerRejections(), "转人工走台账白名单,无强制写入").toEqual([]);
      expect(s.fake.draftCount, "主控不得走常规管线建稿").toBe(1);
    });

    /** 「服务启动扫描」路径:对录像根目录扫一次(带假上传接缝)。 */
    const scanRoots = (logs: string[], notes: string[] = []) => takeoverScanRoots({
      roots: () => [s.recordingsDir],
      log: (m) => logs.push(m),
      notify: (_st, m) => notes.push(m),
      baseOpts: {
        cookies: join(s.root, "cookies.json"), gate: gate(), ...fast(),
        uploadPlainRaw: (o) => s.fake.uploadPlain(o.plain),
        appendGroupRaw: (o) => s.fake.appendGroup(o),
        countPartsRaw: (bv) => s.fake.countVideoParts(bv),
      },
    });
    /** 把旧会话清单的租约改成「别的进程持有」(跨进程场景:同进程 LIVE 表帮不上忙,只能靠租约本身判定)。 */
    const setLease = (base: string, lease: { pid: number; until: number }): void => {
      const f = join(dir(), `${base}.rolling.json`);
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf-8")), lease: { ...lease, holder: "other-process" } }));
    };

    it("跨进程租约有效(pid 存活且未过期)→ 启动扫描跳过:不回读、不续传、清单不被改写", async () => {
      s = await Scenario.create();
      const { oldBase } = await crashMidAppend();
      setLease(oldBase, { pid: process.ppid, until: Date.now() + 600_000 });
      const before = readFileSync(join(dir(), `${oldBase}.rolling.json`), "utf-8");
      const callsBefore = s.fake.calls.length;
      const logs: string[] = [];
      await s.restart();
      const reports = await scanRoots(logs);
      expect(reports.find((r) => r.base === oldBase)?.outcome).toBe("skipped-lease");
      expect(readFileSync(join(dir(), `${oldBase}.rolling.json`), "utf-8")).toBe(before);
      expect(s.fake.calls.length).toBe(callsBefore);
      expect(logs.some((m) => m.includes("接管遗留会话"))).toBe(false);
    });

    it("租约未过期但 pid 已不存在 → 接管并续传;租约已过期(pid 存活/被复用)→ 同样接管", async () => {
      for (const lease of [{ pid: 99_999_999, until: Date.now() + 600_000 }, { pid: process.ppid, until: 1 }]) {
        s?.dispose();
        s = await Scenario.create();
        const { oldBase } = await crashMidAppend();
        setLease(oldBase, lease);
        await s.restart();
        const reports = await scanRoots([]);
        expect(reports.find((r) => r.base === oldBase)?.outcome).toBe("resumed");
        expect(readRolling(oldBase).confirmed).toEqual([0, 1, 2]);
        expect(s.fake.onlyArchive.parts).toHaveLength(3);
      }
    });

    it("租约有效(旧写者仍存活)→ 不接管:不回读、不续传、清单不被改写", async () => {
      s = await Scenario.create();
      const oldStart = pastStartMs(0, 10, 0);
      const oldBase = sessionBaseOf(ANCHOR, oldStart);
      writeSidecars(oldStart);
      const live = uploader([], { appendGroupRaw: () => new Promise<void>(() => {}) });
      for (let i = 0; i < 3; i++) live.noteSegment(writeSegment(oldStart, i));
      void live.flush({ recordingActive: true });
      await new Promise((r) => setTimeout(r, 50));
      const before = readFileSync(join(dir(), `${oldBase}.rolling.json`), "utf-8");
      const callsBefore = s.fake.calls.length;

      const logs: string[] = [];
      const sleeps: number[] = [];
      const newStart = pastStartMs(0, 11, 0);
      writeSidecars(newStart);
      const nu = uploader(logs, fast(sleeps));
      nu.noteSegment(writeSegment(newStart, 0));
      await nu.siblingTakeover;

      expect(readFileSync(join(dir(), `${oldBase}.rolling.json`), "utf-8")).toBe(before);
      expect(s.fake.calls.length, "不得有任何新的外发").toBe(callsBefore);
      expect(sleeps).toEqual([]);
      live.abandon();
      nu.abandon();
    });
  });

  // ── #57 R1 主控止血:建稿中被杀、无稿件号 → 主控绝不走常规整场管线(否则重复建稿),转人工 ──────
  // 注:这是「主控判定」收紧;录制端重启后接管孤立分段(#46)见上面 R2 的接管用例。
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
