/**
 * issue #137 第 2/2:节点侧原地替换容器(无后处理任务,分段封口后 remux → 校验 → 删原文件)。
 *
 * 全部用临时目录 + 假 remux / 假 ffprobe 注入(不依赖本机 ffmpeg,不碰真实录像)。
 * 口径锚点:
 *   - 只剩一份:转换成功后目录里只有新容器的文件;
 *   - 失败保留原文件、无残留临时文件,且告警(不静默);
 *   - 正在写的分段绝不动;收尾后补转最后一段;
 *   - 崩溃接管每个中断点都不删到最后一份;
 *   - 默认 original 时零行为变化。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertSegmentInPlace, DURATION_TOLERANCE_SEC, makeNodeRemuxHookFactory, markSessionNodeFormat,
  NODE_REMUX_TMP_SUFFIX, recoverNodeRemux, REMUX_DISK_HEADROOM_BYTES, remuxTargetPath, resolveNodeOutputFormat,
  type MediaProbe, type NodeRemuxDeps,
} from "../../packages/app/src/node-remux.js";
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import { TaskStore } from "../../packages/app/src/store.js";
import { scanOrphans } from "../../packages/app/src/orphan-cleanup.js";
import { groupSessions, readNodeFormats } from "../../packages/post-process/src/concat.js";
import { upsertHubRule } from "../../packages/app/src/hub-store.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type { RecorderProcess, ExitInfo } from "../../packages/app/src/process/recorder-process.js";

const B = "主播_2026-10-15_21-00-00";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "node-remux-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const f = (n: string): string => join(dir, n);
const put = (n: string, body = "x"): string => { writeFileSync(f(n), body); return f(n); };
const ls = (): string[] => readdirSync(dir).sort();

/** 假 ffprobe:按文件内容里的 `dur=NN` / `novideo` 标记给出结果;读不到的文件 reject。 */
const probe = async (p: string): Promise<MediaProbe> => {
  const body = readFileSync(p, "utf-8");
  if (body.includes("unreadable")) throw new Error("ffprobe: Invalid data");
  const m = /dur=(\d+(?:\.\d+)?)/.exec(body);
  return { durationSec: m ? Number(m[1]) : 0, hasVideo: !body.includes("novideo") };
};
/** 假 remux:把源内容原样复制到临时文件(内容里的标记随之传递);可按需篡改。 */
const copyRemux = (mutate: (body: string) => string = (b) => b): NonNullable<NodeRemuxDeps["remux"]> =>
  async (src, tmp) => { writeFileSync(tmp, mutate(readFileSync(src, "utf-8"))); };

function deps(over: Partial<NodeRemuxDeps> = {}): NodeRemuxDeps & { alerts: string[]; logs: string[] } {
  const alerts: string[] = [], logs: string[] = [];
  return { remux: copyRemux(), probe, freeBytes: () => 1e12, alert: (m) => alerts.push(m), log: (m) => logs.push(m), alerts, logs, ...over };
}

describe("convertSegmentInPlace — 成功路径", () => {
  it("带段号:remux → 校验 → 只剩新容器一份;命名 = 原基名 + 新扩展名,段号保持", async () => {
    put(`${B}_000.ts`, "dur=1800");
    const d = deps();
    const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d);
    expect(r).toEqual({ ok: true, path: f(`${B}_000.mkv`) });
    expect(ls()).toEqual([`${B}_000.mkv`, `${B}.session.json`].sort()); // 原 ts 没了、无临时文件
    expect(d.alerts).toEqual([]);
  });
  it("无段号单文件保持无段号;mp4 同理;flv 源也行", async () => {
    put(`${B}.flv`, "dur=600");
    expect((await convertSegmentInPlace(f(`${B}.flv`), "mp4", deps())).ok).toBe(true);
    expect(ls()).toContain(`${B}.mp4`);
    expect(ls()).not.toContain(`${B}.flv`);
  });
  it("临时文件名带明确后缀且不是视频扩展名(扫描 / 分组不会当成分段)", async () => {
    put(`${B}_000.ts`, "dur=10");
    let seenTmp = "";
    await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", deps({ remux: async (_s, tmp) => { seenTmp = tmp; writeFileSync(tmp, "dur=10"); } }));
    expect(seenTmp).toBe(f(`${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`));
    expect(groupSessions([`${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`], { nodeFormats: new Map([[B, "mkv" as const]]) })).toEqual({});
  });
  it("remuxTargetPath:只换扩展名", () => {
    expect(remuxTargetPath("/a/b/x_000.ts", "mkv")).toBe("/a/b/x_000.mkv");
    expect(remuxTargetPath("/a/b/x.flv", "mp4")).toBe("/a/b/x.mp4");
  });
});

describe("convertSegmentInPlace — 校验失败:原文件保留、无残留临时文件、告警", () => {
  const cases: [string, NodeRemuxDeps["remux"], string][] = [
    ["时长不符(截断)", copyRemux((b) => b.replace("dur=1800", "dur=900")), "verify-failed"],
    ["新文件无视频流", copyRemux((b) => `${b} novideo`), "verify-failed"],
    ["新文件 ffprobe 读不了", copyRemux((b) => `${b} unreadable`), "verify-failed"],
    ["ffmpeg 失败(抛错,且已写出半截临时文件)", async (_s, tmp) => { writeFileSync(tmp, "partial"); throw new Error("ffmpeg rc=1"); }, "remux-failed"],
  ];
  for (const [name, remux, reason] of cases) {
    it(name, async () => {
      put(`${B}_000.ts`, "dur=1800");
      const d = deps({ remux });
      const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d);
      expect(r).toMatchObject({ ok: false, reason });
      expect(readFileSync(f(`${B}_000.ts`), "utf-8")).toBe("dur=1800"); // 原文件原样保留
      expect(ls().filter((n) => n.endsWith(NODE_REMUX_TMP_SUFFIX) || n.endsWith(".mkv"))).toEqual([]);
      expect(d.alerts).toHaveLength(1); // 走告警通道,不静默
      expect(d.alerts[0]).toContain("已保留原文件");
    });
  }
  it("时长差在容差内(≤2s)仍通过", async () => {
    put(`${B}_000.ts`, "dur=1800");
    const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", deps({ remux: copyRemux((b) => b.replace("dur=1800", `dur=${1800 - DURATION_TOLERANCE_SEC}`)) }));
    expect(r.ok).toBe(true);
  });
  it("原文件探测失败(时长未知)→ 不删原文件", async () => {
    put(`${B}_000.ts`, "dur=0");
    const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", deps());
    expect(r).toMatchObject({ ok: false, reason: "verify-failed" });
    expect(ls()).toContain(`${B}_000.ts`);
  });
  it("目标已存在 → 不覆盖、不 remux、保留原文件并告警", async () => {
    put(`${B}_000.ts`, "dur=10");
    put(`${B}_000.mkv`, "someone-else");
    let called = false;
    const d = deps({ remux: async () => { called = true; } });
    expect(await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d)).toMatchObject({ ok: false, reason: "target-exists" });
    expect(called).toBe(false);
    expect(readFileSync(f(`${B}_000.mkv`), "utf-8")).toBe("someone-else");
    expect(d.alerts).toHaveLength(1);
  });
  it("磁盘余量不足 → 跳过并告警,不调 remux(不把盘撑满)", async () => {
    put(`${B}_000.ts`, "dur=10");
    let called = false;
    const d = deps({ freeBytes: () => REMUX_DISK_HEADROOM_BYTES - 1, remux: async () => { called = true; } });
    expect(await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d)).toMatchObject({ ok: false, reason: "no-space" });
    expect(called).toBe(false);
    expect(ls()).toEqual([`${B}_000.ts`]);
    expect(d.alerts[0]).toContain("磁盘余量");
  });
  it("源文件已不存在(被别处处理)→ 安静返回 missing,不告警", async () => {
    const d = deps();
    expect(await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d)).toEqual({ ok: false, reason: "missing" });
    expect(d.alerts).toEqual([]);
  });
});

describe("makeNodeRemuxHookFactory — 封口时机 / 串行 / 收尾补转", () => {
  const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("正在写的分段不被转换;下一段开始后旧段才转;收尾后补转最后一段", async () => {
    put(`${B}_000.ts`, "dur=10"); put(`${B}_001.ts`, "dur=10"); put(`${B}_002.ts`, "dur=10");
    const converted: string[] = [];
    const d = deps({ remux: async (s, tmp) => { converted.push(s); writeFileSync(tmp, readFileSync(s)); } });
    const hook = makeNodeRemuxHookFactory({ format: "mkv", ...d })();
    hook.onSegment(f(`${B}_000.ts`));
    await wait();
    expect(converted).toEqual([]); // 唯一的段仍在写
    expect(ls()).toContain(`${B}_000.ts`);
    hook.onSegment(f(`${B}_001.ts`));
    await wait();
    expect(converted).toEqual([f(`${B}_000.ts`)]); // 001 出现 → 000 封口;001 仍在写
    expect(ls()).toContain(`${B}_001.ts`);
    hook.onSegment(f(`${B}_002.ts`));
    await hook.onSessionEnd(); // 收尾:001、002 都补转
    expect(converted).toEqual([f(`${B}_000.ts`), f(`${B}_001.ts`), f(`${B}_002.ts`)]);
    expect(ls().filter((n) => n.endsWith(".ts"))).toEqual([]);
    expect(ls().filter((n) => n.endsWith(".mkv"))).toHaveLength(3);
  });
  it("并发上限 1:跨会话共用一条队列,任意时刻最多一个 remux 在跑", async () => {
    for (const i of [0, 1, 2]) put(`${B}_00${i}.ts`, "dur=5");
    let running = 0, peak = 0;
    const d = deps({ remux: async (s, tmp) => { running++; peak = Math.max(peak, running); await wait(15); writeFileSync(tmp, readFileSync(s)); running--; } });
    const factory = makeNodeRemuxHookFactory({ format: "mkv", ...d });
    const h1 = factory(), h2 = factory(); // 两个会话
    h1.onSegment(f(`${B}_000.ts`)); h1.onSegment(f(`${B}_001.ts`));
    h2.onSegment(f(`${B}_002.ts`));
    await Promise.all([h1.onSessionEnd(), h2.onSessionEnd()]);
    expect(peak).toBe(1);
    expect(ls().filter((n) => n.endsWith(".mkv"))).toHaveLength(3);
  });
  it("一段失败不影响后续分段(原文件保留 + 告警一次),也不抛出", async () => {
    put(`${B}_000.ts`, "dur=10 bad"); put(`${B}_001.ts`, "dur=10");
    const d = deps({ remux: async (s, tmp) => { const b = readFileSync(s, "utf-8"); if (b.includes("bad")) throw new Error("boom"); writeFileSync(tmp, b); } });
    const hook = makeNodeRemuxHookFactory({ format: "mkv", ...d })();
    hook.onSegment(f(`${B}_000.ts`)); hook.onSegment(f(`${B}_001.ts`));
    await expect(hook.onSessionEnd()).resolves.toBeUndefined();
    expect(ls()).toContain(`${B}_000.ts`);
    expect(ls()).toContain(`${B}_001.mkv`);
    expect(d.alerts).toHaveLength(1);
  });
  it("同一段重复上报不重复转换", async () => {
    put(`${B}_000.ts`, "dur=10");
    let n = 0;
    const d = deps({ remux: async (s, tmp) => { n++; writeFileSync(tmp, readFileSync(s)); } });
    const hook = makeNodeRemuxHookFactory({ format: "mkv", ...d })();
    hook.onSegment(f(`${B}_000.ts`)); hook.onSegment(f(`${B}_000.ts`));
    await hook.onSessionEnd(); await hook.onSessionEnd();
    expect(n).toBe(1);
  });
});

describe("崩溃接管 recoverNodeRemux — 每个中断点都不删到最后一份", () => {
  const sub = (): string => { const d = join(dir, "anchor"); mkdirSync(d, { recursive: true }); return d; };

  it("中断点 1(remux 中途被杀):孤儿临时文件 → 删临时、原文件在", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10");
    writeFileSync(join(d0, `${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`), "partial");
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r.removedTmp).toHaveLength(1);
    expect(readdirSync(d0)).toEqual([`${B}_000.ts`]);
  });
  it("中断点 2(rename 后、删原文件前被杀):新文件通过校验 → 删原文件、留新文件", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=1800");
    writeFileSync(join(d0, `${B}_000.mkv`), "dur=1800");
    markSessionNodeFormat(d0, B, "mkv");
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r.removedOriginal).toEqual([join(d0, `${B}_000.ts`)]);
    expect(readdirSync(d0).sort()).toEqual([`${B}_000.mkv`, `${B}.session.json`].sort());
  });
  it("中断点 2':新文件未通过校验(截断)→ 删新文件、保留原文件", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=1800");
    writeFileSync(join(d0, `${B}_000.mkv`), "dur=100");
    markSessionNodeFormat(d0, B, "mkv");
    const d = deps();
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedNew).toEqual([join(d0, `${B}_000.mkv`)]);
    expect(readdirSync(d0).sort()).toEqual([`${B}_000.ts`, `${B}.session.json`].sort());
    expect(d.alerts).toHaveLength(1);
  });
  it("中断点 3(标记已写、尚未产生任何文件):无事可做,不动原文件", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10");
    markSessionNodeFormat(d0, B, "mkv");
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r).toEqual({ removedTmp: [], removedOriginal: [], removedNew: [] });
    expect(readdirSync(d0)).toContain(`${B}_000.ts`);
  });
  it("无本功能标记的同名配对(别的任务/手工产物)不碰", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}.ts`), "dur=10");
    writeFileSync(join(d0, `${B}.mkv`), "dur=10"); // 没有 session.json 标记
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r).toEqual({ removedTmp: [], removedOriginal: [], removedNew: [] });
    expect(readdirSync(d0).sort()).toEqual([`${B}.mkv`, `${B}.ts`].sort());
  });
  it("配对里新旧都不可读:新文件不过校验 → 只删新文件,原文件(最后一份)在", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "unreadable dur=10");
    writeFileSync(join(d0, `${B}_000.mkv`), "unreadable dur=10");
    markSessionNodeFormat(d0, B, "mkv");
    await recoverNodeRemux(dir, "mkv", deps());
    expect(existsSync(join(d0, `${B}_000.ts`))).toBe(true);
  });
  it("目录不存在 → 安静返回", async () => {
    expect(await recoverNodeRemux(join(dir, "nope"), "mkv", deps())).toEqual({ removedTmp: [], removedOriginal: [], removedNew: [] });
  });
});

describe("session.json:nodeFormat 标记 + 向后兼容", () => {
  it("合并写:保留原有字段;老文件(无字段)= 未转换", () => {
    writeFileSync(f(`${B}.session.json`), JSON.stringify({ sessionBase: B, roomSlug: "123", platform: "douyin", title: "t" }));
    expect(readNodeFormats(dir, ls()).size).toBe(0); // 缺字段 = 未转换
    markSessionNodeFormat(dir, B, "mp4");
    const d = JSON.parse(readFileSync(f(`${B}.session.json`), "utf-8"));
    expect(d).toMatchObject({ roomSlug: "123", platform: "douyin", title: "t", nodeFormat: "mp4" });
    expect(readNodeFormats(dir, ls()).get(B)).toBe("mp4");
  });
  it("损坏 / 非白名单值忽略,绝不抛", () => {
    writeFileSync(f("坏_2026-10-15_21-00-00.session.json"), "{not json");
    writeFileSync(f("非法_2026-10-15_21-00-00.session.json"), JSON.stringify({ nodeFormat: "avi" }));
    writeFileSync(f("原始_2026-10-15_21-00-00.session.json"), JSON.stringify({ nodeFormat: "original" }));
    expect(readNodeFormats(dir, ls()).size).toBe(0);
  });
});

describe("识别:无段号单文件(仅录制目录,靠 session.json)+ stage 分 P 不被当源", () => {
  it("声明 nodeFormat 后,无段号单文件 {base}.mkv 被识别为源;未声明不收", () => {
    const files = [`${B}.mkv`, `${B}.xml`];
    expect(groupSessions(files)).toEqual({}); // 无声明:与 PR 1 一致不收
    const g = groupSessions(files, { nodeFormats: new Map([[B, "mkv" as const]]) });
    expect(g[B].ts).toEqual([`${B}.mkv`]);
    expect(g[B].xml).toBe(`${B}.xml`);
  });
  it("stage 里分段模式产出的分 P(标题模板含时间 → 形如分段)在合并模式下不被当源", () => {
    // stage 目录:分 P 产物 + 没有 session.json 声明(stage 不传 nodeFormats)
    const parts = [`${B}_001.mp4`, `${B}_002.mp4`, `${B}_001_danmu.mp4`];
    expect(groupSessions(parts)).toEqual({});
    // 即便目录里恰好有别的会话的声明,也只对声明的会话 + 声明的扩展名生效
    const g = groupSessions(parts, { nodeFormats: new Map([["别人_2026-10-15_22-00-00", "mp4" as const]]) });
    expect(g).toEqual({});
  });
  it("声明了 mkv 的会话里,同名 mp4 分 P 产物(扩展名不符)与切分产物仍不收", () => {
    const g = groupSessions([`${B}.mkv`, `${B}_001.mp4`, `${B}_part0.mkv`, `${B}_danmu.mkv`], { nodeFormats: new Map([[B, "mkv" as const]]) });
    expect(g[B].ts).toEqual([`${B}.mkv`]);
  });
});

describe("判定矩阵 resolveNodeOutputFormat(spawn 前唯一判定点)", () => {
  let hubDir: string;
  beforeEach(() => { hubDir = join(dir, "hub"); mkdirSync(hubDir, { recursive: true }); });
  const mk = (over: Record<string, unknown> = {}) => ({
    id: 7, room: "https://live.douyin.com/111", managedBy: null as string | null,
    outputFormat: "mkv" as const, rollingEffective: false, ...over,
  });

  it("无规则 + 非受管 + 选 mkv → mkv", () => { expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv"); });
  it("选 original → original(零行为变化)", () => { expect(resolveNodeOutputFormat(mk({ outputFormat: "original" }), hubDir)).toBe("original"); });
  it("hub 受管(worker 上的受管任务)→ original", () => { expect(resolveNodeOutputFormat(mk({ managedBy: "hub" }), hubDir)).toBe("original"); });
  it("有规则以它为 sourceTaskId → original", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 } });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
  });
  it("同房间键的规则(未显式绑 sourceTaskId)→ original(保守)", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111" });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
  });
  it("别的任务 / 别的房间的规则不影响", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "222", recording: { sourceTaskId: 8 } });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
  });
  it("边录边传生效(rolling 上传后删源)→ original,二者互斥", () => {
    expect(resolveNodeOutputFormat(mk({ rollingEffective: true }), hubDir)).toBe("original");
  });
  it("规则之后才绑定:下一次判定起不再替换(已在跑的进程不受影响)", () => {
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 7 } });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
  });
});

describe("接线:TaskManager 在 spawn 前经唯一判定点把生效格式交给 record 参数", () => {
  class FakeProc implements RecorderProcess {
    readonly pid = 1;
    constructor(readonly taskId: number) {}
    start(): void {}
    async stop(): Promise<void> {}
    async stopGraceful(): Promise<void> {}
    onExit(_cb: (i: ExitInfo) => void): void {}
    onLog(_cb: (m: string) => void): void {}
  }
  const argsFor = (taskOver: Record<string, unknown>, opts: { applicable: boolean }): string[] => {
    const store = new TaskStore(":memory:");
    const t = store.addTask({ room: "12345", outputFormat: "mkv", ...taskOver });
    let seen: Record<string, unknown> | undefined;
    const spawner = { spawn: (task: Record<string, unknown>) => { seen = task; return new FakeProc(1); } } as unknown as Spawner;
    const mgr = new TaskManager(store, spawner, {
      log: () => {},
      nodeOutputFormat: (task) => (opts.applicable ? task.outputFormat : "original"),
    });
    mgr.start(t.id);
    return buildRecordArgs(seen as never);
  };
  it("适用 → 带 --output-format mkv;不适用 → 不带(与改动前 argv 逐字一致)", () => {
    expect(argsFor({}, { applicable: true })).toContain("--output-format");
    const off = argsFor({}, { applicable: false });
    expect(off).not.toContain("--output-format");
    expect(off).toEqual(argsFor({ outputFormat: "original" }, { applicable: true }));
  });
  it("TaskManager 未注入判定函数 → 恒 original(不替换)", () => {
    const store = new TaskStore(":memory:");
    const t = store.addTask({ room: "12345", outputFormat: "mkv" });
    let seen: { outputFormat?: string } = {};
    const spawner = { spawn: (task: { outputFormat?: string }) => { seen = task; return new FakeProc(1); } } as unknown as Spawner;
    new TaskManager(store, spawner, { log: () => {} }).start(t.id);
    expect(seen.outputFormat).toBe("original");
  });
});

describe("与清理入口的交互:转换中的临时文件不会被孤儿清理误删", () => {
  it("scanOrphans 不把 *.drec-remux 当 scratch / 孤儿,也不碰对应 session.json", () => {
    const rec = join(dir, "recordings", "anchor");
    mkdirSync(rec, { recursive: true });
    const tmp = join(rec, `${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`);
    writeFileSync(tmp, "converting");
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(tmp, old, old); // 即便很旧也不进删除集(接管只在启动时做)
    writeFileSync(join(rec, `${B}.session.json`), "{}");
    writeFileSync(join(rec, `${B}_000.ts`), "src");
    const r = scanOrphans(dir, { dirs: [rec], staleMs: 1 });
    const all = [...r.scratch, ...r.orphanSession, ...r.emptyXml];
    expect(all.filter((i) => i.path === tmp)).toEqual([]);
    expect(all.filter((i) => i.path.endsWith(".session.json") && i.keepReason === null)).toEqual([]);
  });
  it("转换成功后 session.json 带视频(mkv)存活 → 不是孤儿 sidecar", () => {
    const rec = join(dir, "recordings", "anchor");
    mkdirSync(rec, { recursive: true });
    writeFileSync(join(rec, `${B}_000.mkv`), "v");
    writeFileSync(join(rec, `${B}.session.json`), JSON.stringify({ nodeFormat: "mkv" }));
    const r = scanOrphans(dir, { dirs: [rec] });
    expect(r.orphanSession.filter((i) => i.keepReason === null)).toEqual([]); // 只可能是「保留」项,绝不进删除集
  });
});

describe("默认 original 零行为变化(对照)", () => {
  it("buildRecordArgs:original / 缺省 → argv 不含 --output-format,与改动前一致", () => {
    const base = { id: 1, room: "12345", name: null, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800, outDir: "/o", rollingEffective: false } as never;
    const args = buildRecordArgs(base);
    expect(args).not.toContain("--output-format");
    expect(buildRecordArgs({ ...(base as object), outputFormat: "original" } as never)).toEqual(args);
    expect(buildRecordArgs({ ...(base as object), outputFormat: "mkv" } as never).slice(-2)).toEqual(["--output-format", "mkv"]);
  });
  it("manager 收尾覆盖 session.json 时保留 nodeFormat(整文件覆盖不得抹掉标记)", async () => {
    // _writeSession 是私有方法;经公开路径验证:先有带标记的文件,再让 manager 写同名文件
    const { RecordingSession } = await import("../../packages/manager/src/index.js");
    const s = new RecordingSession({ name: "x" } as never) as unknown as { _writeSession(base: string, g?: boolean): void; roomUrl: string };
    s.roomUrl = "https://live.douyin.com/111";
    const base = join(dir, B);
    writeFileSync(`${base}.session.json`, JSON.stringify({ nodeFormat: "mkv", roomSlug: "old" }));
    s._writeSession(base, true);
    const d = JSON.parse(readFileSync(`${base}.session.json`, "utf-8"));
    expect(d.nodeFormat).toBe("mkv");
    expect(d.sessionBase).toBe(B);
    // 无旧文件 → 无标记
    const base2 = join(dir, "另一场_2026-10-15_23-00-00");
    s._writeSession(base2);
    expect(JSON.parse(readFileSync(`${base2}.session.json`, "utf-8")).nodeFormat).toBeUndefined();
  });
});

describe("hub 绑定后识别节点替换产物(scanRecordings,只在录制目录)", () => {
  it("session.json 声明 nodeFormat → 无段号单文件 mkv 与带段号 mkv 都进清单;老会话(无声明)的 mp4 合并产物不进", async () => {
    const { scanRecordings } = await import("../../packages/orchestrator/src/scan.js");
    const rec = join(dir, "recordings");
    const a = join(rec, "anchor"); mkdirSync(a, { recursive: true });
    const B2 = "主播_2026-10-14_21-00-00";
    // 新会话:无段号单文件(segmentSec=0 录的)已被节点替换成 mkv
    writeFileSync(join(a, `${B}.mkv`), "v");
    writeFileSync(join(a, `${B}.xml`), "<i></i>");
    writeFileSync(join(a, `${B}.session.json`), JSON.stringify({ sessionBase: B, roomSlug: "111", platform: "douyin", nodeFormat: "mkv" }));
    // 老会话:ts 源 + 旧 session.json(缺字段)+ 手工合并产物 {base}.mp4(不得当源)
    writeFileSync(join(a, `${B2}_000.ts`), "v");
    writeFileSync(join(a, `${B2}.mp4`), "merged");
    writeFileSync(join(a, `${B2}.session.json`), JSON.stringify({ sessionBase: B2, roomSlug: "111", platform: "douyin" }));
    const rs = await scanRecordings(rec, {}, async () => ({ durationSec: 10, startMs: 1, endMs: 2 }));
    const byBase = Object.fromEntries(rs.map((r) => [r.sessionBase, r.tsFiles.map((x) => x.split("/").pop())]));
    expect(byBase[B]).toEqual([`${B}.mkv`]);
    expect(byBase[B2]).toEqual([`${B2}_000.ts`]); // 与改动前一致
  });
});
