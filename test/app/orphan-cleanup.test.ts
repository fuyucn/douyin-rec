/**
 * orphan-cleanup(T13) —— 可预览、可审计的孤儿/空壳/scratch 清理。
 *
 * 口径(每个用例都锚在一条硬约束上):
 *   - 有内容的 xml 永不进删除集 —— AGENTS.md「不得删掉最后一份」(唯一弹幕源);
 *   - 空壳 xml 只有「同会话别处有非空 xml」才可删;
 *   - 孤儿 = session.json 而无视频无 xml(有视频/有 xml 就不是孤儿,选优/身份依赖);
 *   - dryRun 不删任何东西;真删与预览一致;真删落审计日志;
 *   - 正在录制/正在上传的路径一律 keep(扫目录撞上正在写的分段是最危险的窗口)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformForRoom } from "@drec/core";
import { DatabaseSync } from "node:sqlite";
import {
  isEmptyXml, scanOrphans, cleanupOrphans,
} from "../../packages/app/src/orphan-cleanup.js";
import { buildMaintenance } from "../../packages/app/src/web/api/maintenance.js";
import { matchRoute } from "../../packages/app/src/web/server.js";
import { TaskStore } from "../../packages/app/src/store.js";

const NONEMPTY = `<?xml version="1.0" encoding="UTF-8"?><i><d p="2.000,1,25,16777215,0,0,9,9,0" user="a">hi</d></i>`;
const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><i></i>`;

describe("isEmptyXml", () => {
  it("0 字节 / 只有壳 → true;弹幕/礼物/上舰任一 → false", () => {
    expect(isEmptyXml("")).toBe(true);
    expect(isEmptyXml(EMPTY)).toBe(true);
    expect(isEmptyXml(NONEMPTY)).toBe(false);
    expect(isEmptyXml(`<i><gift user="a" giftname="心"/></i>`)).toBe(false);
    expect(isEmptyXml(`<i><member user="b"/></i>`)).toBe(false);
    expect(isEmptyXml(`<i><d>裸弹幕</d></i>`)).toBe(false);
  });
});

describe("scanOrphans / cleanupOrphans", () => {
  let root: string, rec: string, stage: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orphan-"));
    rec = join(root, "recordings");
    stage = join(root, "stage");
    mkdirSync(join(rec, "主播"), { recursive: true });
    mkdirSync(stage, { recursive: true });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const put = (p: string, body = ""): void => {
    mkdirSync(join(p.slice(0, p.lastIndexOf("/"))), { recursive: true });
    writeFileSync(p, body, "utf-8");
  };
  const stale = (p: string): void => {
    // 把 mtime 拨回 1 天前 —— scratch 陈旧判定走 mtime,测试不睡 6h。
    const t = new Date(Date.now() - 24 * 3600_000);
    utimesSync(p, t, t);
  };

  it("有内容的 xml 与含 gaps 的 session 永不进入删除集", () => {
    const base = `主播A_2026-10-09_20-00-00`;
    put(join(rec, "主播", `${base}.xml`), NONEMPTY);
    put(join(rec, "主播", `${base}.session.json`), JSON.stringify({ gaps: [{ startMs: 1, endMs: 2 }] }));
    put(join(rec, "主播", `${base}_000.ts`), "fake-video");
    const scan = scanOrphans(root);
    // 有内容 xml 根本不是「空壳」候选;有视频的 sidecar 不是孤儿 → 两个集合都空
    expect(scan.emptyXml.filter((i) => i.keepReason === null)).toEqual([]);
    expect(scan.orphanSession.filter((i) => i.keepReason === null)).toEqual([]);
  });

  it("无视频但 xml 有内容的会话 → session.json 保留(非孤儿)", () => {
    const base = `主播B_2026-10-09_21-00-00`;
    put(join(rec, "主播", `${base}.xml`), NONEMPTY);
    put(join(rec, "主播", `${base}.session.json`), JSON.stringify({ roomSlug: "123" }));
    const scan = scanOrphans(root);
    expect(scan.orphanSession.every((i) => i.keepReason !== null)).toBe(true);
  });

  it("空壳 xml:有非空副本时可删;无副本时拒删(唯一一份)", () => {
    const base = `主播C_2026-10-09_22-00-00`;
    put(join(rec, "主播", `${base}_000.xml`), EMPTY);      // 同会话空壳
    put(join(rec, "主播", `${base}_001.xml`), NONEMPTY);   // 同会话非空副本
    const lone = `主播D_2026-10-09_22-30-00`;
    put(join(rec, "主播", `${lone}.xml`), EMPTY);          // 唯一的空壳
    const scan = scanOrphans(root);
    const byPath = (p: string) => scan.emptyXml.find((i) => i.path === p)!;
    expect(byPath(join(rec, "主播", `${base}_000.xml`)).keepReason).toBeNull();
    const loneItem = byPath(join(rec, "主播", `${lone}.xml`));
    expect(loneItem.keepReason).not.toBeNull();
    expect(loneItem.keepReason).toContain("最后一份");
  });

  it("stage 里的非空副本也能保 recordings 的空壳不被删", () => {
    const base = `主播E_2026-10-09_23-00-00`;
    put(join(rec, "主播", `${base}.xml`), EMPTY);
    put(join(stage, `${base}.xml`), NONEMPTY); // stage 副本(已上传/合并留下的)
    const scan = scanOrphans(root);
    const item = scan.emptyXml.find((i) => i.path === join(rec, "主播", `${base}.xml`))!;
    expect(item.keepReason).toBeNull();
  });

  it("真正的孤儿 session.json(无视频无 xml)→ 可删;删除后重扫为空", () => {
    const base = `主播F_2026-10-09_23-30-00`;
    const sidecar = join(rec, "主播", `${base}.session.json`);
    put(sidecar, JSON.stringify({ roomSlug: "404" }));
    let scan = scanOrphans(root);
    expect(scan.orphanSession.some((i) => i.path === sidecar && i.keepReason === null)).toBe(true);
    const r = cleanupOrphans(root, { dryRun: false });
    expect(r.failed).toEqual([]);
    expect(existsSync(sidecar)).toBe(false);
    scan = scanOrphans(root);
    expect(scan.orphanSession.filter((i) => i.keepReason === null)).toEqual([]);
  });

  it("dryRun 只返回清单不删文件;预览与实际删除集一致", () => {
    const base = `主播G_2026-10-09_23-40-00`;
    put(join(rec, "主播", `${base}_000.xml`), EMPTY);
    put(join(rec, "主播", `${base}_001.xml`), NONEMPTY);
    put(join(rec, "主播", `${base}.session.json`), JSON.stringify({}));       // 非孤儿(有 xml)
    put(join(rec, "主播", `${base}.upload`), "scratch"); stale(join(rec, "主播", `${base}.upload`));
    const preview = cleanupOrphans(root, {}); // 默认 dryRun
    expect(preview.dryRun).toBe(true);
    expect(preview.deleted).toEqual([]);
    expect(readdirSync(join(rec, "主播")).length).toBe(4); // 一个没少
    const run = cleanupOrphans(root, { dryRun: false });
    // 预览的「可删集」与真删的「删掉集」路径一致
    const previewDeletable = [
      ...preview.emptyXml, ...preview.orphanSession, ...preview.scratch,
    ].filter((i) => i.keepReason === null).map((i) => i.path).sort();
    expect(run.deleted.map((d) => d.path).sort()).toEqual(previewDeletable);
    expect(run.failed).toEqual([]);
  });

  it("真删写审计日志(deleted 行);无可删时不建日志", () => {
    const base = `主播H_2026-10-09_23-50-00`;
    put(join(rec, "主播", `${base}_000.xml`), EMPTY);
    put(join(rec, "主播", `${base}_001.xml`), NONEMPTY);
    const r = cleanupOrphans(root, { dryRun: false });
    expect(r.auditPath).not.toBeNull();
    const lines = readFileSync(r.auditPath!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.action === "deleted" && l.kind === "emptyXml")).toBe(true);
    // 第二次再跑:无可删 → 不写日志也不建新条目
    const r2 = cleanupOrphans(root, { dryRun: false });
    expect(r2.auditPath).toBeNull();
  });

  it("正在录制/正在上传的文件不被删(活动保护优先级最高)", () => {
    const base = `主播I_2026-10-09_23-55-00`;
    put(join(rec, "主播", `${base}_000.xml`), EMPTY);
    put(join(rec, "主播", `${base}_001.xml`), NONEMPTY);   // 本来可删…
    put(join(rec, "主播", `${base}.live.upload`), "wip");
    const scan = scanOrphans(root, { recordingDirs: [join(rec, "主播")], activePaths: [] });
    expect(scan.emptyXml.every((i) => i.keepReason !== null)).toBe(true);
    expect(scan.scratch.every((i) => i.keepReason !== null)).toBe(true);
    const run = cleanupOrphans(root, { dryRun: false, recordingDirs: [join(rec, "主播")] });
    expect(run.deleted).toEqual([]);
  });

  it("太新的 scratch 不删(陈旧判定);够旧的才删", () => {
    put(join(stage, "job.upload"), "wip");
    put(join(stage, "fresh.upload"), "new"); // 刚写的,mtime=now
    stale(join(stage, "job.upload"));
    const scan = scanOrphans(root);
    const items = Object.fromEntries(scan.scratch.map((i) => [i.path.split("/").pop(), i]));
    expect(items["job.upload"].keepReason).toBeNull();
    expect(items["fresh.upload"].keepReason).not.toBeNull();
  });

  it("空目录/扫描根不存在 → 空结果,不抛", () => {
    const scan = scanOrphans(join(root, "no-such-root"));
    expect(scan.emptyXml).toEqual([]);
    expect(scan.orphanSession).toEqual([]);
    expect(scan.scratch).toEqual([]);
    expect(scan.reclaimableBytes).toBe(0);
  });

  it("有内容的 xml 完全不出现在 emptyXml 里(调用方无法误当垃圾删掉)", () => {
    const base = `主播J_2026-10-10_00-00-00`;
    put(join(rec, "主播", `${base}.xml`), NONEMPTY);
    const scan = scanOrphans(root);
    expect(scan.emptyXml.map((i) => i.path)).toEqual([]);
    cleanupOrphans(root, { dryRun: false });
    expect(existsSync(join(rec, "主播", `${base}.xml`))).toBe(true);
  });

  it("删除阶段再判一次活动性:扫描后新开播 → 不删(跨状态变化的安全网)", () => {
    const base = `主播K_2026-10-10_00-10-00`;
    put(join(rec, "主播", `${base}_000.xml`), EMPTY);
    put(join(rec, "主播", `${base}_001.xml`), NONEMPTY); // 可删
    // cleanup 时才把该目录标成「正在录制」(模拟扫描后开播)
    const r = cleanupOrphans(root, { dryRun: false, recordingDirs: [join(rec, "主播")] });
    expect(r.deleted).toEqual([]);
    expect(existsSync(join(rec, "主播", `${base}_000.xml`))).toBe(true);
  });
});

describe("maintenance 端点(T13 API 层)", () => {
  const origRoot = process.env.DOUYIN_REC_ROOT;
  afterEach(() => { if (origRoot === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = origRoot; });

  const mkManager = (recordingIds: number[] = []) => ({
    runningIds: () => [],
    isRunning: () => true,
    start: () => true,
    stop: async () => {},
    stopGraceful: async () => {},
    getRuntime: () => ({} as never),
    getAnchorName: () => "主播",
    isRecording: (id: number) => recordingIds.includes(id),
    getLogs: () => [],
  });
+
  it("路由注册:GET 预览 / POST 执行(未知方法不匹配)", () => {
    expect(matchRoute("GET", "/api/maintenance/orphans")).toEqual({ name: "previewOrphans" });
    expect(matchRoute("POST", "/api/maintenance/orphans")).toEqual({ name: "cleanupOrphans", needsBody: true });
    expect(matchRoute("DELETE", "/api/maintenance/orphans")).toBeNull();
  });
+
  it("未显式 confirm → 400,不删任何东西", () => {
    const root = mkdtempSync(join(tmpdir(), "orphan-api-"));
    process.env.DOUYIN_REC_ROOT = root;
    const store = new TaskStore(":memory:");
    const api = buildMaintenance({ store, manager: mkManager() as never, dataRoot: root });
    expect(api.cleanupOrphans({}).status).toBe(400);
    expect(api.cleanupOrphans(undefined).status).toBe(400);
    expect(api.cleanupOrphans({ confirm: false }).status).toBe(400);
    expect(api.previewOrphans().status).toBe(200);
    rmSync(root, { recursive: true, force: true });
  });
+
  it("正在录制的任务目录 → 预览里其下空壳 xml 全部标为保留", () => {
    const root = mkdtempSync(join(tmpdir(), "orphan-api2-"));
    process.env.DOUYIN_REC_ROOT = root;
    const anchorDir = join(root, "recordings", "主播");
    mkdirSync(anchorDir, { recursive: true });
    writeFileSync(join(anchorDir, "s_2026-10-10_00-00-00.xml"), EMPTY, "utf-8");
    const store = new TaskStore(":memory:");
    const api = buildMaintenance({ store, manager: mkManager([1]) as never, dataRoot: root });
    const res = api.previewOrphans();
    expect(res.status).toBe(200);
    const body = res.body as { emptyXml: { keepReason: string | null }[] };
    expect(body.emptyXml.length).toBeGreaterThan(0);
    expect(body.emptyXml.every((i) => i.keepReason !== null)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("maintenance protects room-layout recording dirs (issue #333)", () => {
  const mk = (recordingIds: number[]) => ({
    isRecording: (id: number) => recordingIds.includes(id),
    getAnchorName: () => null,
  });
  const run = (withRoomDir: boolean): { keepReason: string | null }[] => {
    const root = mkdtempSync(join(tmpdir(), "orphan-room-"));
    const savedRoot = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = root;
    try {
      const store = new TaskStore(":memory:");
      const task = store.addTask({ room: "111", name: "NameA" });
      const p = platformForRoom("111");
      // The legacy directory exists too (name directory), the room directory only when asked.
      const dirs = [join(root, "recordings", "NameA")];
      if (withRoomDir) dirs.push(join(root, "recordings", `Renamed_${p.id}_${p.extractRoomSlug("111")}`));
      const old = new Date(Date.now() - 48 * 3600_000);
      for (const d of dirs) {
        mkdirSync(d, { recursive: true });
        const f = join(d, "s_2026-10-10_00-00-00.xml");
        writeFileSync(f, EMPTY, "utf-8");
        utimesSync(f, old, old); // stale: only the active-directory protection can keep it
      }
      // A non-empty copy of the same session elsewhere makes the empty shells deletable, so a keepReason
      // can only come from the active-directory protection.
      mkdirSync(join(root, "stage"), { recursive: true });
      writeFileSync(join(root, "stage", "s_2026-10-10_00-00-00.xml"), NONEMPTY, "utf-8");
      const api = buildMaintenance({ store, manager: mk([task.id]) as never, dataRoot: root });
      const body = api.previewOrphans().body as { emptyXml: { path: string; keepReason: string | null }[] };
      return body.emptyXml.filter((i) => i.path.includes(withRoomDir ? "Renamed_" : "NameA"));
    } finally {
      if (savedRoot === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("recording task: the suffix-matched room directory is protected, not just the name directory", () => {
    const items = run(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.keepReason !== null)).toBe(true);
  });
  it("control: the legacy name directory of a recording task stays protected", () => {
    const items = run(false);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.keepReason !== null)).toBe(true);
  });
});

describe("maintenance protects the stage dirs of active hub jobs in BOTH layouts (issue #336)", () => {
  const run = (state: string): { legacy: (string | null)[]; room: (string | null)[] } => {
    const root = mkdtempSync(join(tmpdir(), "orphan-stage-"));
    const savedRoot = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = root;
    try {
      const stage = join(root, "stage");
      const KEY = "douyin:555:2026-10-10";
      const legacyDir = join(stage, "douyin_555_2026-10-10");
      const roomDir = join(stage, "Someone_douyin_555", "2026-10-10");
      const old = new Date(Date.now() - 48 * 3600_000);
      for (const d of [legacyDir, roomDir]) {
        mkdirSync(d, { recursive: true });
        const f = join(d, "s_2026-10-10_00-00-00.xml");
        writeFileSync(f, EMPTY, "utf-8");
        utimesSync(f, old, old); // stale: only the active-job protection can keep it
      }
      // a non-empty copy of the same session elsewhere makes the empty shells deletable
      mkdirSync(join(root, "recordings", "x"), { recursive: true });
      writeFileSync(join(root, "recordings", "x", "s_2026-10-10_00-00-00.xml"), NONEMPTY, "utf-8");
      const syncDb = join(root, "x-sync.db");
      const db = new DatabaseSync(syncDb);
      db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
        winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
      db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run(KEY, state, Date.now());
      db.close();
      const api = buildMaintenance({ store: new TaskStore(":memory:"), manager: { isRecording: () => false, getAnchorName: () => null } as never, dataRoot: root, syncDbPath: syncDb, stageDir: stage });
      const body = api.previewOrphans().body as { emptyXml: { path: string; keepReason: string | null }[] };
      const pick = (dir: string): (string | null)[] => body.emptyXml.filter((i) => i.path.startsWith(dir)).map((i) => i.keepReason);
      return { legacy: pick(legacyDir), room: pick(roomDir) };
    } finally {
      if (savedRoot === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = savedRoot;
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("active job (merging): the old-layout dir and the room-layout dir are both kept", () => {
    const r = run("merging");
    expect(r.legacy.length).toBeGreaterThan(0);
    expect(r.room.length).toBeGreaterThan(0);
    expect(r.legacy.every((k) => k !== null)).toBe(true);
    expect(r.room.every((k) => k !== null)).toBe(true);
  });
  it("control: a finished job (done) protects neither, so the shells are deletable", () => {
    const r = run("done");
    expect(r.legacy.every((k) => k === null)).toBe(true);
    expect(r.room.every((k) => k === null)).toBe(true);
  });
});

describe("scanOrphans 分段后缀大小写口径(issue #50)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orphan-case-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const put = (p: string, body = ""): void => {
    mkdirSync(join(p.slice(0, p.lastIndexOf("/"))), { recursive: true });
    writeFileSync(p, body, "utf-8");
  };
  const base = "主播_2026-10-09_20-00-00";

  it("混写大小写的 part 后缀与 PART 同属一个会话:sidecar 不误判孤儿", () => {
    put(join(root, "recordings", "主播", `${base}-part000.ts`), "v");
    put(join(root, "recordings", "主播", `${base}.session.json`), "{}");
    const r = scanOrphans(root);
    expect(r.orphanSession).toHaveLength(1);
    expect(r.orphanSession[0]!.keepReason).not.toBeNull(); // 有视频 → 保留
  });

  it("空壳 xml 与别处非空 xml 后缀大小写不同仍归同一会话:空壳可删,非空永不进删除集", () => {
    put(join(root, "recordings", "主播", `${base}_PART000.xml`), EMPTY);
    put(join(root, "stage", `${base}_part001.xml`), NONEMPTY);
    const r = scanOrphans(root);
    const empty = r.emptyXml.find((i) => i.path.endsWith("_PART000.xml"));
    expect(empty?.keepReason).toBeNull();
    expect(r.emptyXml.some((i) => i.path.endsWith("_part001.xml"))).toBe(false);
  });

  it("唯一一份空壳(别处无非空 xml)即使后缀大小写不同也保留", () => {
    put(join(root, "recordings", "主播", `${base}-Part000.xml`), EMPTY);
    const r = scanOrphans(root);
    expect(r.emptyXml[0]!.keepReason).not.toBeNull();
  });
});
