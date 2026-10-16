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
  NODE_REMUX_SUSPECT_SUFFIX, STALE_TMP_MIN_AGE_MS, NODE_REMUX_TMP_SUFFIX, recoverNodeRemux, REMUX_DISK_HEADROOM_BYTES, remuxTargetPath, resolveNodeOutputFormat, shouldConvertAtSeal, nodeOutputFormatLock,
  parseRemuxTmpName, remuxTmpPath, verifyRemuxed, packetAllowance, recoverNodeRemuxInBackground,
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
  const dur = m ? Number(m[1]) : 0;
  // 假探测:跨度默认等于头部时长;`span=NN` 单独指定(模拟「头部时长完好、尾部被截断」);`nopackets` = 扫包无结果。
  const sp = /span=(\d+(?:\.\d+)?)/.exec(body);
  return { durationSec: dur, hasVideo: !body.includes("novideo"), spanSec: sp ? Number(sp[1]) : dur, packets: body.includes("nopackets") || dur === 0 ? 0 : 100 };
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
    await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", deps({ owner: "t1", pid: 4242, remux: async (_s, tmp) => { seenTmp = tmp; writeFileSync(tmp, "dur=10"); } }));
    // 临时文件名带归属(任务标识 + pid):`{final}.{owner}-{pid}.drec-remux`
    expect(seenTmp).toBe(f(`${B}_000.mkv.t1-4242${NODE_REMUX_TMP_SUFFIX}`));
    expect(parseRemuxTmpName(seenTmp)).toEqual({ owner: "t1", pid: 4242 });
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
    ["头部时长完好、尾部被截断(扫包末帧不符)", copyRemux((b) => b.replace("span=1800", "span=180")), "verify-failed"],
    ["新文件扫不到视频包", copyRemux((b) => `${b} nopackets`), "verify-failed"],
    ["体积远小于原文件(<下限)", async (s, tmp) => { writeFileSync(tmp, "dur=1800 span=1800"); void s; }, "verify-failed"],
    ["新文件无视频流", copyRemux((b) => `${b} novideo`), "verify-failed"],
    ["新文件 ffprobe 读不了", copyRemux((b) => `${b} unreadable`), "verify-failed"],
    ["ffmpeg 失败(抛错,且已写出半截临时文件)", async (_s, tmp) => { writeFileSync(tmp, "partial"); throw new Error("ffmpeg rc=1"); }, "remux-failed"],
  ];
  for (const [name, remux, reason] of cases) {
    it(name, async () => {
      put(`${B}_000.ts`, `dur=1800 span=1800 ${"p".repeat(1000)}`);
      const d = deps({ remux });
      const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d);
      expect(r).toMatchObject({ ok: false, reason });
      expect(readFileSync(f(`${B}_000.ts`), "utf-8")).toBe(`dur=1800 span=1800 ${"p".repeat(1000)}`); // 原文件原样保留
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

describe("删除顺序:先校验、落盘、改名,最后才删原文件(守护:任一前序步骤抛错 → 原文件仍在)", () => {
  for (const [name, over] of [
    ["fsync 抛错", { fsync: () => { throw new Error("EIO"); } }],
    ["rename 抛错", { rename: () => { throw new Error("EXDEV"); } }],
  ] as const) {
    it(`${name} → 原文件原样在、新文件不存在、无残留临时文件、告警`, async () => {
      put(`${B}_000.ts`, "dur=1800");
      const d = deps(over);
      const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d);
      expect(r).toMatchObject({ ok: false, reason: "remux-failed" });
      expect(readFileSync(f(`${B}_000.ts`), "utf-8")).toBe("dur=1800");
      expect(ls().filter((n) => n.endsWith(".mkv") || n.endsWith(NODE_REMUX_TMP_SUFFIX))).toEqual([]);
      expect(d.alerts).toHaveLength(1);
    });
  }
  it("校验失败时原文件也在(删原文件不得先于校验)", async () => {
    put(`${B}_000.ts`, "dur=1800");
    const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", deps({ remux: copyRemux((b) => b.replace("dur=1800", "dur=1800 span=1")) }));
    expect(r.ok).toBe(false);
    expect(existsSync(f(`${B}_000.ts`))).toBe(true);
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
  const EMPTY = { removedTmp: [], skippedFreshTmp: [], removedOriginal: [], keptBoth: [] };
  const age = (p: string, ms: number): void => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

  it("中断点 1(remux 中途被杀):陈旧孤儿临时文件 → 删临时、原文件在,并告警「该段保持原容器」", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10");
    const tmp = join(d0, `${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`);
    writeFileSync(tmp, "partial");
    age(tmp, STALE_TMP_MIN_AGE_MS + 60_000);
    const d = deps();
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedTmp).toEqual([tmp]);
    expect(readdirSync(d0)).toEqual([`${B}_000.ts`]);
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]).toContain("被中断");
    expect(d.alerts[0]).toContain("保持原容器");
  });
  it("新鲜临时文件(可能是别的任务正在转换)不删、不告警;陈旧的才删", async () => {
    const fresh = join(dir, "taskA"), stale = join(dir, "taskB");
    mkdirSync(fresh); mkdirSync(stale);
    const tf = join(fresh, `${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`), ts = join(stale, `${B}_000.mkv${NODE_REMUX_TMP_SUFFIX}`);
    writeFileSync(tf, "being-written"); writeFileSync(ts, "dead");
    age(ts, STALE_TMP_MIN_AGE_MS + 1000);
    age(tf, STALE_TMP_MIN_AGE_MS - 60_000); // 差一分钟才算旧
    const d = deps();
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.skippedFreshTmp).toEqual([tf]);
    expect(r.removedTmp).toEqual([ts]);
    expect(existsSync(tf)).toBe(true);
    expect(existsSync(ts)).toBe(false);
    expect(d.alerts).toHaveLength(1); // 只为被删的那个告警
  });
  it("中断点 2(rename 后、删原文件前被杀):新文件通过校验 → 删原文件、留新文件,并告警接管", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=1800");
    writeFileSync(join(d0, `${B}_000.mkv`), "dur=1800");
    markSessionNodeFormat(d0, B, "mkv");
    const d = deps();
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedOriginal).toEqual([join(d0, `${B}_000.ts`)]);
    expect(readdirSync(d0).sort()).toEqual([`${B}_000.mkv`, `${B}.session.json`].sort());
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]).toContain("被中断");
  });
  for (const [name, newBody, origBody] of [
    ["时长被截断", "dur=100", "dur=1800"],
    ["头部时长完好、尾部被截断(扫包末帧不符)", "dur=1800 span=100", "dur=1800"],
    ["新文件探测失败(无法判定)", "unreadable dur=1800", "dur=1800"],
    ["原文件探测失败(无法判定)", "dur=1800", "unreadable dur=1800"],
    ["新旧都不可读", "unreadable", "unreadable"],
  ] as const) {
    it(`中断点 2':新文件存疑(${name})→ 两份都保留(新文件改名隔离)+ 告警,绝不删任何一份`, async () => {
      const d0 = sub();
      writeFileSync(join(d0, `${B}_000.ts`), origBody);
      writeFileSync(join(d0, `${B}_000.mkv`), newBody);
      markSessionNodeFormat(d0, B, "mkv");
      const d = deps();
      const r = await recoverNodeRemux(dir, "mkv", d);
      expect(r.keptBoth).toEqual([join(d0, `${B}_000.mkv`)]);
      expect(r.removedOriginal).toEqual([]);
      expect(readFileSync(join(d0, `${B}_000.ts`), "utf-8")).toBe(origBody);
      expect(readFileSync(join(d0, `${B}_000.mkv${NODE_REMUX_SUSPECT_SUFFIX}`), "utf-8")).toBe(newBody);
      expect(d.alerts).toHaveLength(1);
      expect(d.alerts[0]).toContain("保持原容器");
      // 隔离后不再被当成分段:分组只看到原文件,不重复计入
      expect(groupSessions(readdirSync(d0), { nodeFormats: new Map([[B, "mkv" as const]]) })[B].ts).toEqual([`${B}_000.ts`]);
      // 二次接管幂等:不再重复告警、不删任何东西
      const d2 = deps();
      expect(await recoverNodeRemux(dir, "mkv", d2)).toEqual(EMPTY);
      expect(d2.alerts).toEqual([]);
    });
  }
  it("中断点 3(标记已写、尚未产生任何文件):无事可做,不动原文件", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10");
    markSessionNodeFormat(d0, B, "mkv");
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r).toEqual(EMPTY);
    expect(readdirSync(d0)).toContain(`${B}_000.ts`);
  });
  it("无本功能标记的同名配对(别的任务/手工产物)不碰", async () => {
    const d0 = sub();
    writeFileSync(join(d0, `${B}.ts`), "dur=10");
    writeFileSync(join(d0, `${B}.mkv`), "dur=10"); // 没有 session.json 标记
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r).toEqual(EMPTY);
    expect(readdirSync(d0).sort()).toEqual([`${B}.mkv`, `${B}.ts`].sort());
  });
  it("目录不存在 → 安静返回", async () => {
    expect(await recoverNodeRemux(join(dir, "nope"), "mkv", deps())).toEqual(EMPTY);
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
  it("nodeOutputFormatLock:原因 = hub-managed / rolling / no-survivors / 无;与所选格式无关(选 original 也报锁);enabled 规则任务不再锁(T9b)", () => {
    expect(nodeOutputFormatLock(mk(), hubDir)).toBeUndefined();
    expect(nodeOutputFormatLock(mk({ managedBy: "hub" }), hubDir)).toBe("hub-managed");
    expect(nodeOutputFormatLock(mk({ rollingEffective: true }), hubDir)).toBe("rolling");
    expect(nodeOutputFormatLock(mk({ outputFormat: "original", rollingEffective: true }), hubDir)).toBe("rolling");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111" });
    // T9b:有 enabled 规则(默认清理开关 = 全留存)→ 不锁;但封口仍不转(resolve 仍 original)
    expect(nodeOutputFormatLock(mk(), hubDir)).toBeUndefined();
    // 锁 ⇒ resolve 必为 original(单向)
    for (const over of [{ managedBy: "hub" }, { rollingEffective: true }, {}]) {
      expect(resolveNodeOutputFormat(mk(over), hubDir)).toBe("original");
    }
  });
  it("规则之后才绑定:下一次判定起不再替换(已在跑的进程不受影响)", () => {
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 7 } });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
  });
});

describe("T8:shouldConvertAtSeal / 锁同源 + 禁用规则不算绑定(plans/036 F3 / N2)", () => {
  let hubDir: string;
  beforeEach(() => { hubDir = join(dir, "hub"); mkdirSync(hubDir, { recursive: true }); });
  const mk = (over: Record<string, unknown> = {}) => ({
    id: 7, room: "https://live.douyin.com/111", managedBy: null as string | null,
    outputFormat: "mkv" as const, rollingEffective: false, ...over,
  });

  it("绑定 enabled 规则(sourceTaskId / 房间键两种绑法)+ 选 mkv → original(录制中绝不转换)", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: true });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
    expect(shouldConvertAtSeal(mk(), hubDir)).toBe(false);
  });
  it("规则 disabled(sourceTaskId 绑定)+ 选 mkv → mkv(封口转换);不锁", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: false });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
    expect(shouldConvertAtSeal(mk(), hubDir)).toBe(true);
    expect(nodeOutputFormatLock(mk(), hubDir)).toBeUndefined();
  });
  it("规则 disabled(房间键同名)+ 选 mkv → mkv;不锁", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
    expect(nodeOutputFormatLock(mk(), hubDir)).toBeUndefined();
  });
  it("规则 disabled 之后又被启用 → 立即回到 original(现读不缓存);不锁", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("mkv");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: true });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
    expect(nodeOutputFormatLock(mk(), hubDir)).toBeUndefined();
  });
  it("disabled 规则不盖过 enabled 规则:同时存在时封口仍不转", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false });
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: true });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
    expect(shouldConvertAtSeal(mk(), hubDir)).toBe(false);
  });
  it("T9b 前后:绑定 enabled 规则的任务 resolveNodeOutputFormat 均为 original(处理中途从不转换),选 mkv / mp4 皆然", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: true });
    for (const fmt of ["mkv", "mp4", "original"] as const) {
      expect(resolveNodeOutputFormat(mk({ outputFormat: fmt }), hubDir), fmt).toBe("original");
    }
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: true, pipeline: { cleanup: { sourceAfterDone: true, stageAfterDone: true } } });
    expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original"); // no-survivors 锁住时同样
  });
  it("no-survivors:规则使节点与 stage 都不留源视频才锁;任一侧留存则不锁", () => {
    const cases: Array<[Record<string, boolean>, string | undefined]> = [
      [{}, undefined],
      [{ sourceAfterDone: true }, undefined],                                   // stage 仍留
      [{ stageAfterDone: true }, undefined],                                    // 节点仍留
      [{ sourceAfterDone: true, stageAfterDone: true }, "no-survivors"],
      [{ sourceAfterDone: true, stageSourceAfterMerge: true }, "no-survivors"],
      [{ stageSourceAfterMerge: true }, undefined],
    ];
    for (const [cleanup, want] of cases) {
      upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: true, pipeline: { cleanup } });
      expect(nodeOutputFormatLock(mk(), hubDir), JSON.stringify(cleanup)).toBe(want);
      expect(resolveNodeOutputFormat(mk(), hubDir)).toBe("original");
    }
  });
  it("每种规则状态 × 受管 / rolling:锁 ⇒ resolveNodeOutputFormat()==='original'(选 mkv);shouldConvertAtSeal ⇔ resolve 不是 original;受管 / rolling 必锁", () => {
    const ruleStates: Array<[string, () => void]> = [
      ["无规则", () => {}],
      ["enabled · sourceTaskId", () => { upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: true }); }],
      ["enabled · 房间键", () => { upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: true }); }],
      ["disabled · sourceTaskId", () => { upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 }, enabled: false }); }],
      ["disabled · 房间键", () => { upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false }); }],
      ["别的任务的 enabled 规则", () => { upsertHubRule(hubDir, { platform: "douyin", roomSlug: "222", recording: { sourceTaskId: 8 }, enabled: true }); }],
    ];
    for (const [name, setup] of ruleStates) {
      for (const hubDirN of [name]) { // 每个状态一个干净 hubDir
        const d = join(dir, `hub-${hubDirN}`); mkdirSync(d, { recursive: true });
        hubDir = d; setup();
        for (const over of [{}, { managedBy: "hub" }, { rollingEffective: true }]) {
          const t = mk(over);
          const locked = nodeOutputFormatLock(t, hubDir) !== undefined;
          const resolved = resolveNodeOutputFormat(t, hubDir);
          if (locked) expect(resolved, `${name} ${JSON.stringify(over)}`).toBe("original"); // 锁 ⇒ 不转(单向)
          expect(shouldConvertAtSeal(t, hubDir), `${name} ${JSON.stringify(over)}`).toBe(resolved !== "original");
          if (over.managedBy || over.rollingEffective) expect(locked, `${name} ${JSON.stringify(over)}`).toBe(true);
        }
      }
    }
  });
  it("选 original 时恒 original,与规则状态无关(但 disabled 规则下不报锁)", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false });
    expect(resolveNodeOutputFormat(mk({ outputFormat: "original" }), hubDir)).toBe("original");
    expect(nodeOutputFormatLock(mk({ outputFormat: "original" }), hubDir)).toBeUndefined();
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

// ───────────── issue #137 返工第 2 轮 ─────────────

describe("verifyRemuxed — 视频包数 / 音频 / 内容告警(假探测,边界值)", () => {
  const base: MediaProbe = { durationSec: 1800, hasVideo: true, spanSec: 1800, packets: 45000, gopPackets: 50, hasAudio: true, audioPackets: 77000, scanErrors: 0 };
  const run = async (o: Partial<MediaProbe>, s: Partial<MediaProbe> = {}): Promise<string | undefined> => {
    put("a.ts", "x".repeat(100)); put("a.mkv", "x".repeat(100));
    return verifyRemuxed(f("a.ts"), f("a.mkv"), async (p) => (p.endsWith(".ts") ? { ...base, ...s } : { ...base, ...o }));
  };
  it("包数容差 = min(GOP, 0.5%),至少 1:45000 包 → 50;300 包 → 2;GOP 未知只用比例", () => {
    expect(packetAllowance(45000, 50)).toBe(50);
    expect(packetAllowance(45000, 500)).toBe(225);
    expect(packetAllowance(300, 50)).toBe(2);
    expect(packetAllowance(10, 50)).toBe(1);
    expect(packetAllowance(45000)).toBe(225);
  });
  it("视频包数:少一个 GOP 以内通过;多丢一个就拒;中段丢 30%(1800→1193 同量级)被拒", async () => {
    expect(await run({ packets: 45000 - 50 })).toBeUndefined();
    expect(await run({ packets: 45000 - 51 })).toMatch(/视频包数不足/);
    expect(await run({ packets: 31500 })).toMatch(/视频包数不足/);
  });
  it("音频:原有音频而新文件无音频流 → 拒;音频包数少于容差 → 拒;在容差内通过", async () => {
    expect(await run({ hasAudio: false, audioPackets: 0 })).toMatch(/缺少音频流/);
    expect(await run({ audioPackets: 77000 - 386 })).toMatch(/音频包数不足/);
    expect(await run({ audioPackets: 77000 - 385 })).toBeUndefined();
  });
  it("原文件无音频:新文件有无音频都不拒(只要求不丢原有的)", async () => {
    expect(await run({ hasAudio: false, audioPackets: 0 }, { hasAudio: false, audioPackets: 0 })).toBeUndefined();
  });
  it("内容告警:新文件 ffprobe 告警行多于原文件 → 拒;不多于原文件通过", async () => {
    expect(await run({ scanErrors: 50 })).toMatch(/解析告警多于原文件/);
    expect(await run({ scanErrors: 50 }, { scanErrors: 50 })).toBeUndefined();
  });
  it("探测挂死(永不返回)→ 在上界内按无法判定失败,不无限等", async () => {
    put("a.ts", "x"); put("a.mkv", "x");
    const t0 = Date.now();
    const r = await verifyRemuxed(f("a.ts"), f("a.mkv"), () => new Promise<MediaProbe>(() => {}), 80);
    expect(r).toMatch(/无法探测.*探测超时/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("临时文件归属:任务标识 + pid", () => {
  const sub = (n: string): string => { const d = join(dir, n); mkdirSync(d, { recursive: true }); return d; };
  const age = (p: string, ms: number): void => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };
  const tmpOf = (d: string, owner: string, pid: number): string => join(d, `${B}_000.mkv.${owner}-${pid}${NODE_REMUX_TMP_SUFFIX}`);

  it("remuxTmpPath / parseRemuxTmpName 往返;老格式(无归属)解析为 undefined", () => {
    const p = remuxTmpPath(f(`${B}_000.mkv`), "123456", 99);
    expect(parseRemuxTmpName(p)).toEqual({ owner: "123456", pid: 99 });
    expect(parseRemuxTmpName(`${B}_000.mkv.drec-remux`)).toBeUndefined();
  });
  it("同任务、进程已不存在的新鲜残留 → 立即删除并告警(不必等 2 小时)", async () => {
    const d0 = sub("a"); const t = tmpOf(d0, "room1", 111); writeFileSync(t, "partial"); // mtime = 刚刚
    const d = deps({ owner: "room1", pid: 222, pidAlive: () => false });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedTmp).toEqual([t]);
    expect(existsSync(t)).toBe(false);
    expect(d.alerts).toHaveLength(1);
    expect(d.alerts[0]).toContain("保持原容器");
  });
  it("同任务但写它的进程仍存活 → 不碰(新鲜)", async () => {
    const d0 = sub("a"); const t = tmpOf(d0, "room1", 111); writeFileSync(t, "partial");
    const d = deps({ owner: "room1", pid: 222, pidAlive: () => true });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.skippedFreshTmp).toEqual([t]);
    expect(existsSync(t)).toBe(true);
    expect(d.alerts).toEqual([]);
  });
  it("别的任务的新鲜残留(即使其进程已不存在)→ 不碰、不告警", async () => {
    const d0 = sub("a"); const t = tmpOf(d0, "other", 111); writeFileSync(t, "partial");
    const d = deps({ owner: "room1", pid: 222, pidAlive: () => false });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.skippedFreshTmp).toEqual([t]);
    expect(existsSync(t)).toBe(true);
    expect(d.alerts).toEqual([]);
  });
  it("别的任务的陈旧(>2h)残留仍可删", async () => {
    const d0 = sub("a"); const t = tmpOf(d0, "other", 111); writeFileSync(t, "partial"); age(t, STALE_TMP_MIN_AGE_MS + 1000);
    const d = deps({ owner: "room1", pid: 222, pidAlive: () => true });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedTmp).toEqual([t]);
    expect(d.alerts).toHaveLength(1);
  });
  it("本进程自己的临时文件(pid 相同)绝不当残留", async () => {
    const d0 = sub("a"); const t = tmpOf(d0, "room1", 222); writeFileSync(t, "partial");
    const r = await recoverNodeRemux(dir, "mkv", deps({ owner: "room1", pid: 222, pidAlive: () => false }));
    expect(r.removedTmp).toEqual([]);
    expect(existsSync(t)).toBe(true);
  });
});

describe("接管竞态:校验失败时原文件已不存在 → 跳过、不隔离", () => {
  it("校验期间对方任务删了原文件:新文件是唯一一份,不改名、不删、不告警", async () => {
    const d0 = join(dir, "a"); mkdirSync(d0);
    writeFileSync(join(d0, `${B}_000.ts`), "dur=1800");
    writeFileSync(join(d0, `${B}_000.mkv`), "dur=1800");
    markSessionNodeFormat(d0, B, "mkv");
    // 探测原文件时(校验必然失败:无法探测)模拟对方任务「删原文件」
    const d = deps({ probe: async (p) => { if (p.endsWith(".ts")) { rmSync(p); throw new Error("ENOENT"); } return probe(p); } });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.keptBoth).toEqual([]);
    expect(r.removedOriginal).toEqual([]);
    expect(readdirSync(d0).sort()).toEqual([`${B}_000.mkv`, `${B}.session.json`].sort()); // 新文件原名原位,没被隔离
    expect(d.alerts).toEqual([]);
  });
  it("对照:原文件仍在而校验失败 → 照旧隔离新文件、两份都留(回归)", async () => {
    const d0 = join(dir, "a"); mkdirSync(d0);
    writeFileSync(join(d0, `${B}_000.ts`), "dur=1800");
    writeFileSync(join(d0, `${B}_000.mkv`), "dur=1800 unreadable");
    markSessionNodeFormat(d0, B, "mkv");
    const r = await recoverNodeRemux(dir, "mkv", deps());
    expect(r.keptBoth).toHaveLength(1);
    expect(existsSync(join(d0, `${B}_000.ts`))).toBe(true);
    expect(existsSync(join(d0, `${B}_000.mkv${NODE_REMUX_SUSPECT_SUFFIX}`))).toBe(true);
  });
});

describe("接管后台执行 + 总时限;收尾总时限", () => {
  it("recoverNodeRemuxInBackground:慢探测时调用方立刻拿到 Promise(不被等待),探测放行后才完成", async () => {
    const d0 = join(dir, "a"); mkdirSync(d0);
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10"); writeFileSync(join(d0, `${B}_000.mkv`), "dur=10");
    markSessionNodeFormat(d0, B, "mkv");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let done = false;
    const p = recoverNodeRemuxInBackground(dir, "mkv", deps({ probe: async (x) => { await gate; return probe(x); } })).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false); // 探测还卡着,但调用方(开录路径)已经往下走了
    expect(existsSync(join(d0, `${B}_000.ts`))).toBe(true);
    release();
    const r = await p;
    expect(r?.removedOriginal).toEqual([join(d0, `${B}_000.ts`)]);
  });
  it("总时限:探测永不返回 → 到点结束并告警,不 reject;未处理的配对两份都在", async () => {
    const d0 = join(dir, "a"); mkdirSync(d0);
    writeFileSync(join(d0, `${B}_000.ts`), "dur=10"); writeFileSync(join(d0, `${B}_000.mkv`), "dur=10");
    markSessionNodeFormat(d0, B, "mkv");
    const d = deps({ probe: () => new Promise<MediaProbe>(() => {}) });
    const r = await recoverNodeRemuxInBackground(dir, "mkv", d, 60);
    expect(r).toBeUndefined();
    expect(d.alerts.some((m) => m.includes("总时限"))).toBe(true);
    expect(existsSync(join(d0, `${B}_000.ts`))).toBe(true);
    expect(existsSync(join(d0, `${B}_000.mkv`))).toBe(true);
  });
  it("一个文件探测挂死不影响其它文件:挂死那份两份都留,另一份正常接管", async () => {
    const d0 = join(dir, "a"); mkdirSync(d0);
    const B2 = "主播_2026-10-15_22-00-00";
    for (const b of [B, B2]) {
      writeFileSync(join(d0, `${b}_000.ts`), "dur=10"); writeFileSync(join(d0, `${b}_000.mkv`), "dur=10");
      markSessionNodeFormat(d0, b, "mkv");
    }
    const d = deps({ probeBoundMs: 50, probe: async (p) => (p.includes(B2) ? new Promise<MediaProbe>(() => {}) : probe(p)) });
    const r = await recoverNodeRemux(dir, "mkv", d);
    expect(r.removedOriginal).toEqual([join(d0, `${B}_000.ts`)]);
    expect(existsSync(join(d0, `${B2}_000.ts`))).toBe(true); // 挂死的:原文件保留
  });
  it("会话收尾总时限:remux 挂死 → onSessionEnd 在时限内返回、告警、原文件保留;之后的转换放弃", async () => {
    put(`${B}_000.ts`, "dur=10");
    const d = deps({ remux: () => new Promise<void>(() => {}) });
    const hook = makeNodeRemuxHookFactory({ format: "mkv", sessionEndBudgetMs: 80, ...d })();
    hook.onSegment(f(`${B}_000.ts`));
    const t0 = Date.now();
    await hook.onSessionEnd();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(d.alerts.some((m) => m.includes("总时限"))).toBe(true);
    expect(existsSync(f(`${B}_000.ts`))).toBe(true);
    expect(ls().some((n) => n.endsWith(NODE_REMUX_TMP_SUFFIX))).toBe(false);
  });
  it("收尾总时限内正常完成 → 不告警、转换成功(时限不影响常规路径)", async () => {
    put(`${B}_000.ts`, "dur=10");
    const d = deps();
    const hook = makeNodeRemuxHookFactory({ format: "mkv", sessionEndBudgetMs: 5000, ...d })();
    hook.onSegment(f(`${B}_000.ts`));
    await hook.onSessionEnd();
    expect(d.alerts).toEqual([]);
    expect(ls()).toContain(`${B}_000.mkv`);
  });
  it("shouldAbort:放弃后 remux 完成也不校验、不改名,清临时文件、保留原文件", async () => {
    put(`${B}_000.ts`, "dur=10");
    let abort = false;
    const d = deps({ shouldAbort: () => abort, remux: async (s, tmp) => { writeFileSync(tmp, readFileSync(s)); abort = true; } });
    const r = await convertSegmentInPlace(f(`${B}_000.ts`), "mkv", d);
    expect(r).toMatchObject({ ok: false, reason: "aborted" });
    expect(ls()).toEqual([`${B}_000.ts`, `${B}.session.json`].sort());
  });
});

describe("混合容器:同一会话部分分段已转 mkv、部分仍是 ts", () => {
  it("groupSessions:声明 nodeFormat=mkv 的会话里 mkv 与 ts 分段按段号交错排序、同归一个会话", () => {
    const files = [`${B}_002.ts`, `${B}_000.mkv`, `${B}_001.ts`, `${B}_003.mkv`, `${B}.xml`];
    const g = groupSessions(files, { nodeFormats: new Map([[B, "mkv" as const]]) });
    expect(Object.keys(g)).toEqual([B]);
    expect(g[B].ts).toEqual([`${B}_000.mkv`, `${B}_001.ts`, `${B}_002.ts`, `${B}_003.mkv`]);
    expect(g[B].xml).toBe(`${B}.xml`);
  });
  it("没有声明时 mkv 一个都不收(只剩 ts)——对照", () => {
    const g = groupSessions([`${B}_000.mkv`, `${B}_001.ts`]);
    expect(g[B].ts).toEqual([`${B}_001.ts`]);
  });
});
