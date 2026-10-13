/**
 * T19:节点侧上传共限流持久化 601 冷却 —— node-pipeline 的上传路径必须过 core UploadGate。
 *
 * 覆盖:① 命中 601 → 冷却跨「重启」(新 gate 实例 + 新 store 实例)保留;
 *      ② 冷却期内节点侧上传被阻塞;③ 账号键解析(与 master 同键/异键);
 *      ④ master 与节点共享同一限流状态文件时,总提交数不超 rateLimit(并发场景)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadGate, openUploadLimitStore, biliAccountKeyFromCookiesJson } from "@drec/core";
import { nodeStageCleanupTargets, openNodeUploadGate, planGroups, prepareNodeUploadAlias, readNodeResult, resolveUploadAccountKey, runNodeSidePipeline, splitGroupsBySession, writeNodeResult, abortNodeExecutor, isExecutorCmdline, nodeExecutorPidPath } from "../../packages/app/src/node-pipeline.js";
import { remuxSegment } from "@drec/post-process";
import { uploadPlain, appendGroup, countVideoParts } from "../../packages/app/src/upload/biliup.js";

// node:fs 走 spy(默认透传真实实现)—— 只有「硬链接不可用」用例才临时打桩 linkSync 抛错。
vi.mock("node:fs", { spy: true });

// 全局 setup 已先于本文件加载 @drec/core(其 node:fs 绑定不受上面的 spy 影响),
// 故「硬链接不可用」改经 linkOrCopy 的注入口(fs)模拟 EXDEV。
const linkFail = vi.hoisted(() => ({ on: false }));
vi.mock("@drec/core", async (orig) => {
  const m = await orig<typeof import("@drec/core")>();
  const fs = await import("node:fs");
  return {
    ...m,
    linkOrCopy: (s: string, d: string, o?: Parameters<typeof m.linkOrCopy>[2]) =>
      m.linkOrCopy(s, d, linkFail.on ? {
        ...o,
        fs: {
          linkSync: () => { throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); },
          copyFileSync: fs.copyFileSync,
          statSync: fs.statSync,
        },
      } : o),
  };
});
// 逐段 remux/合并/时长探测是外部进程调用,这里换成可控替身(只影响本文件的节点侧用例)。
vi.mock("@drec/post-process", async (orig) => {
  const actual = await orig<typeof import("@drec/post-process")>();
  return {
    ...actual,
    ffprobeDuration: async () => 60,
    remuxSegment: vi.fn(async (_src: string, out: string) => { writeFileSync(out, "REMUXED"); }),
    mergeSession: async (_inputs: string[], out: string) => { writeFileSync(out, "MERGED"); },
  };
});

// biliup 上传外部进程换成 spy(issue #2 A3：幂等重入须证明「有 bv → 绝不重复 uploadPlain」)。
vi.mock("../../packages/app/src/upload/biliup.js", () => ({
  uploadPlain: vi.fn(async () => "BV1NEW"),
  appendGroup: vi.fn(async () => {}),
  countVideoParts: vi.fn(async () => null),
}));

const silence = (): void => {};
const tmp = (): string => join(mkdtempSync(join(tmpdir(), "node-gate-")), "x.db");
function clock(start = 1_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += Math.max(0, ms); }, advance: (ms) => { t += ms; } };
}

describe("节点侧上传限流(T19)", () => {
  it("命中 601 → 冷却写入节点本地库;新 gate 实例(等价重启)冷却仍在", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    const key = biliAccountKeyFromCookiesJson(JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "42" }] } }));

    await expect(gate.run(key, async () => { throw new Error("code: 601"); })).rejects.toThrow();
    store.close();

    // 「重启」:全新 store + 全新 gate,冷却必须还在(不因进程重启清零)。
    const store2 = openUploadLimitStore(db, { log: silence });
    const gate2 = new UploadGate({ store: store2, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    const t0 = c.now();
    await gate2.awaitSlot(key); // 冷却期内 → 阻塞到截止
    expect(c.now() - t0).toBe(30_000);
    store2.close();
  });

  it("冷却期内节点侧上传被拒绝(等够冷却才放行),非立刻重试", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 20_000, rateLimit: 100, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("bilibili:42");
    const t0 = c.now();
    await gate.run("bilibili:42", async () => "bv");
    expect(c.now() - t0).toBe(20_000);
    store.close();
  });

  it("master 与节点用同一 store 文件 + 同一账号键 → 总提交数不超 rateLimit(并发)", async () => {
    const db = tmp();
    const c = clock();
    // 模拟 master ResourcePool 与节点 UploadGate 两个独立进程,共用该 db 文件。
    const masterStore = openUploadLimitStore(db, { log: silence });
    const nodeStore = openUploadLimitStore(db, { log: silence });
    const { ResourcePool } = await import("@drec/orchestrator");
    const pool = new ResourcePool(
      { uploadRateLimit: 2, uploadRateWindowMs: 1000, uploadCooldownMs: 5000 },
      { now: c.now, sleep: c.sleep, limitStore: masterStore, limitKey: "bilibili:42", warn: silence },
    );
    const nodeGate = new UploadGate({
      store: nodeStore, rateLimit: 2, windowMs: 1000, cooldownMs: 5000, now: c.now, sleep: c.sleep, warn: silence,
    });
    const key = "bilibili:42";
    // 并发 6 次提交(master 3 + 节点 3)。
    // 断言打在**限流账本**上,而不是「await 返回时刻」:注入的假时钟会被别的并发调用 sleep 推进,
    // 一个调用醒来时 now 可能已晚于自己占额的时刻(语义正常)。账本才是配额的权威。
    await Promise.all([
      pool.withUpload(async () => 1, "s1"),
      pool.withUpload(async () => 2, "s2"),
      nodeGate.awaitSlot(key),
      pool.withUpload(async () => 3, "s3"),
      nodeGate.awaitSlot(key),
      nodeGate.awaitSlot(key),
    ]);
    const st = masterStore.load(key);
    expect(st).not.toBeNull();
    const times = st!.times;
    // 账本只保留**当前窗口**(tryClaim 每次按窗口裁剪重写),窗口内条目数即已占配额数。
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((x) => Number.isFinite(x))).toBe(true);
    // master + 节点合计不超过 rateLimit=2 —— 这正是「共享限流桶」的验收标准。
    expect(times.length).toBeLessThanOrEqual(2);
    const spread = times[times.length - 1] - times[0];
    expect(spread).toBeLessThan(1000);
    masterStore.close();
    nodeStore.close();
  });

  it("不同账号互不影响(节点 A 的冷却不挡节点 B)", async () => {
    const db = tmp();
    const c = clock();
    const store = openUploadLimitStore(db, { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 30_000, rateLimit: 5, now: c.now, sleep: c.sleep, warn: silence });
    gate.recordRateLimit("bilibili:1");
    const t0 = c.now();
    await gate.awaitSlot("bilibili:2");
    expect(c.now() - t0).toBe(0); // 另一账号立即放行
    store.close();
  });

  it("openNodeUploadGate:库损坏 → fail-closed 冷却(不是无限速)", async () => {
    const db = tmp();
    writeFileSync(db, "not sqlite");
    const c = clock();
    const gate = openNodeUploadGate({ store: openUploadLimitStore(db, { log: silence }), rateLimit: 5, cooldownMs: 0, warn: silence });
    // 注入假时钟需重开 gate:openNodeUploadGate 未暴露时钟 → 用 store 损坏 + 默认时钟断言不抛即可。
    // 真实验证时钟相关行为见 core/upload-gate.test.ts 的 fail-closed 用例。
    expect(() => gate.peek("k")).not.toThrow();
  });

  it("resolveUploadAccountKey:读本机 cookies.json;缺失/损坏 → unknown 桶", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    const p = join(dir, "cookies.json");
    writeFileSync(p, JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "777" }] } }));
    expect(resolveUploadAccountKey(p)).toBe("bilibili:777");
    writeFileSync(p, "{broken");
    expect(resolveUploadAccountKey(p)).toBe("bilibili:unknown");
    expect(resolveUploadAccountKey(join(dir, "nope.json"))).toBe("bilibili:unknown");
  });
});

/**
 * 节点侧产物的**分组/命名**纯逻辑。
 *
 * 这里必须与 master 分段模式**逐字一致**(唯一真理 = post-process 的 `planSegmentGroups`):
 * 曾经节点侧另写了一份「累计 ≥ 0.8×目标就切」的近似算法 → 同一场在节点侧与 master 侧切出
 * **不同的分 P 数/长度**,稿件形态就变了。
 */
describe("节点侧分组/命名(与 master 同源)", () => {
  const T = (i: number): string => `/r/s_${String(i).padStart(3, "0")}.ts`;

  it("planGroups:groupSec<=0 → 逐段一个分 P(与 master 相同)", () => {
    const files = [T(0), T(1), T(2)];
    expect(planGroups(files, 0, [60, 60, 60], () => "")).toEqual([[T(0)], [T(1)], [T(2)]]);
  });

  it("planGroups:按累计时长聚组,单组不超 target×1.2(与 planSegmentGroups 同口径)", () => {
    const files = [T(0), T(1), T(2), T(3)];
    // target=100 → limit=120:60+60 超限 → 两两成组。
    expect(planGroups(files, 100, [60, 60, 60, 60], () => "")).toEqual([
      [T(0), T(1)],
      [T(2), T(3)],
    ]);
    // target=120 → limit=144:60+60=120 ≤144,可并入 → 前两段一组,后两段一组(第三段 180 超限)。
    expect(planGroups(files, 120, [60, 60, 60, 60], () => "")).toEqual([
      [T(0), T(1)],
      [T(2), T(3)],
    ]);
  });

  it("planGroups:单段自身超过上限 → 独占一组(不切它)", () => {
    const files = [T(0), T(1)];
    expect(planGroups(files, 60, [10, 500], () => "")).toEqual([[T(0)], [T(1)]]);
  });

  it("splitGroupsBySession:同一个分 P 绝不跨会话(跨会话 → 弹幕窗口错位/丢失)", () => {
    // 组 [0,1,2] 里 0/1 属会话 A、2 属会话 B → 必须切成 [0,1] 与 [2]。
    const xmlOf = (i: number): string => (i < 2 ? "/r/a.xml" : "/r/b.xml");
    expect(splitGroupsBySession([[0, 1, 2]], xmlOf)).toEqual([[0, 1], [2]]);
  });

  it("splitGroupsBySession:无 xml(空串)也算同一会话,不因缺失而乱切", () => {
    expect(splitGroupsBySession([[0, 1, 2]], () => "")).toEqual([[0, 1, 2]]);
  });

  it("prepareNodeUploadAlias:建硬链接别名(同 inode,零拷贝);stem 为空 → 回落原名", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias-"));
    const canonical = join(dir, "114275050882_2026-10-11_09-50-00_000.mp4");
    writeFileSync(canonical, "video");

    const alias = prepareNodeUploadAlias(dir, "P1", canonical);
    expect(alias).toBe(join(dir, ".upload", "P1.mp4"));
    expect(statSync(alias).ino).toBe(statSync(canonical).ino); // 硬链接 = 同一 inode
    expect(readFileSync(alias, "utf-8")).toBe("video");

    expect(prepareNodeUploadAlias(dir, null, canonical)).toBe(canonical); // 未配模板 → 原名
  });

  it("prepareNodeUploadAlias:重名别名重建 → 指向最新产物(不残留旧内容)", () => {
    const dir = mkdtempSync(join(tmpdir(), "alias2-"));
    const a = join(dir, "x_000.mp4");
    const b = join(dir, "x_001.mp4");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    prepareNodeUploadAlias(dir, "P2", a);
    const alias = prepareNodeUploadAlias(dir, "P2", b); // 同名 → 覆盖
    expect(readFileSync(alias, "utf-8")).toBe("B");
    expect(statSync(alias).ino).toBe(statSync(b).ino);
  });
});

/**
 * 节点侧路径**没有 pull** ⇒ master 的 `clean_stage` 只清 master 自己的 stageSub,
 * 节点 stage 里的成品 mp4 + `.work/` 中间产物永远没人清(线上实测:VPS2 一个房间留 3.4G)。
 * 这里钉死节点侧自己的清理口径(与 master `clean_stage` 同义)。
 */
describe("nodeStageCleanupTargets(节点 stage 收尾口径)", () => {
  function makeStageDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nodestage-"));
    writeFileSync(join(dir, "Lilt_2026-10-12_000.mp4"), "v");
    writeFileSync(join(dir, "Lilt_2026-10-12_001.mp4"), "v");
    writeFileSync(join(dir, "Lilt_2026-10-12.xml"), "x");
    writeFileSync(join(dir, "Lilt_2026-10-12.ass"), "a");
    mkdirSync(join(dir, ".work"), { recursive: true });
    writeFileSync(join(dir, ".work", "000.mp4"), "v");
    mkdirSync(join(dir, ".upload"), { recursive: true });
    writeFileSync(join(dir, ".upload", "P1.mp4"), "v");
    return dir;
  }

  it("默认删成品 mp4 + .work/ + .upload/,但**不**碰 .xml/.ass", () => {
    const dir = makeStageDir();
    const targets = nodeStageCleanupTargets(dir).map((p) => p.replace(dir + "/", ""));
    expect(targets.sort()).toEqual([
      ".upload",
      ".work",
      "Lilt_2026-10-12_000.mp4",
      "Lilt_2026-10-12_001.mp4",
    ]);
  });

  it("deleteXml=true(stageAfterDone 开)→ 连 .xml/.ass 一并删(此时节点源 xml 被保留)", () => {
    const dir = makeStageDir();
    const targets = nodeStageCleanupTargets(dir, { deleteXml: true }).map((p) => p.replace(dir + "/", ""));
    expect(targets).toContain("Lilt_2026-10-12.xml");
    expect(targets).toContain("Lilt_2026-10-12.ass");
    expect(targets).toHaveLength(6);
  });

  it("目录不存在 → 空数组(清理路径绝不反噬)", () => {
    expect(nodeStageCleanupTargets(join(tmpdir(), "definitely-not-here-12345"))).toEqual([]);
  });
});

/**
 * 节点侧**落盘结果文件**往返(「假失败」修复的另一半,见 orchestrator/node-side-upload.test.ts)。
 *
 * master 经 ssh 调 `_node-pipeline` 是长命令,ssh 可能在节点跑完上传后才断开 ⇒ master 回读该文件
 * 才是权威结果。这里钉死:上传前 `uploading`、成功后 `done+bv`、建稿后 append 失败 `failed+bv`,
 * 以及「损坏/缺字段 → null」(master 按确认没成处理,绝不误判成成功)。
 */
describe("节点侧结果文件 writeNodeResult / readNodeResult", () => {
  const sub = (): string => mkdtempSync(join(tmpdir(), "noderes-"));

  it("无文件 → null(节点没跑过该场)", () => {
    expect(readNodeResult(sub())).toBeNull();
  });

  it("损坏 JSON → null(绝不抛,也绝不误判成功)", () => {
    const dir = sub();
    writeFileSync(join(dir, ".drec-node-result.json"), "{not json");
    expect(readNodeResult(dir)).toBeNull();
  });

  it("phase 非法 → null(防旧/脏文件被当成权威结果)", () => {
    const dir = sub();
    writeFileSync(join(dir, ".drec-node-result.json"), JSON.stringify({ phase: "weird", ok: true }));
    expect(readNodeResult(dir)).toBeNull();
  });

  it("done + bv 往返:bv / products / atMs 保真", () => {
    const dir = sub();
    writeNodeResult(dir, { phase: "done", ok: true, bv: "BV1X", products: ["/s/a.mp4"] }, silence);
    const r = readNodeResult(dir);
    expect(r?.phase).toBe("done");
    expect(r?.ok).toBe(true);
    expect(r?.bv).toBe("BV1X");
    expect(r?.products).toEqual(["/s/a.mp4"]);
    expect(typeof r?.atMs).toBe("number");
    expect(r!.atMs).toBeGreaterThan(0);
  });

  it("started(A1 尽早落盘)→ ok=false、无 bv;master 据此区分「已接管未建稿」", () => {
    const dir = sub();
    writeNodeResult(dir, { phase: "started", ok: false }, silence);
    const r = readNodeResult(dir);
    expect(r?.phase).toBe("started");
    expect(r?.ok).toBe(false);
    expect(r?.bv).toBeUndefined(); // started 本身**不代表已建稿**
  });

  it("uploading(上传前落盘)→ ok=false、无 bv;master 据此判「结果不确定」", () => {
    const dir = sub();
    writeNodeResult(dir, { phase: "uploading", ok: false }, silence);
    const r = readNodeResult(dir);
    expect(r).toEqual({ phase: "uploading", ok: false, bv: undefined, products: undefined, error: undefined, atMs: r!.atMs });
    expect(r!.ok).toBe(false);
    expect(r!.bv).toBeUndefined();
  });

  it("failed 带 bv(建稿后 append 失败)→ bv 保真,master 据此判「已建稿、绝不重传」", () => {
    const dir = sub();
    writeNodeResult(dir, { phase: "failed", ok: false, bv: "BV1PART", error: "append 挂在 3/5" }, silence);
    const r = readNodeResult(dir);
    expect(r?.phase).toBe("failed");
    expect(r?.bv).toBe("BV1PART");
    expect(r?.error).toContain("append");
  });
});

/**
 * issue #6:节点侧「中间产物 → 规范上传名」也改「同盘硬链接优先」。
 *
 * 改前 `copyFileSync(work, out)`:同一份数据在 stage 存两遍,上传进行中峰值磁盘翻倍
 * (实测某场:源 ≈5.1G + `.work/` ≈4.9G + 顶层规范名 ≈4.9G ≈ 15.5G,节点盘 49G)。
 * 中间产物(`.work/<段号>.mp4`)与规范名同在 stage 子目录、同一文件系统 ⇒ 硬链接零额外空间。
 *
 * 这里跑**真的** `runNodeSidePipeline`(stage 模式,不触发 biliup),用真文件系统验证落盘形态;
 * remux/时长探测换成可控替身(见文件顶部 vi.mock)。
 */
describe("节点侧:中间产物 → 规范上传名改同盘硬链接(issue #6)", () => {
  /** 造一个「节点本地录制目录 + stage 目录」的临时场景,返回 spec(不烧录、不上传)。 */
  function scene(): { stageDir: string; sub: string; spec: Parameters<typeof runNodeSidePipeline>[0] } {
    const root = mkdtempSync(join(tmpdir(), "node-hl-"));
    const recDir = join(root, "recordings");
    mkdirSync(recDir, { recursive: true });
    const tsFiles = [0, 1, 2].map((i) => {
      const p = join(recDir, `Lilt_2026-10-12_05-18-36_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(p, "src");
      return p;
    });
    const stageDir = join(root, "stage");
    mkdirSync(stageDir, { recursive: true });
    return {
      stageDir,
      sub: join(stageDir, "douyin_123_2026-10-12"),
      spec: {
        streamKey: "douyin:123:2026-10-12",
        tsFiles,
        sessionBase: "Lilt_2026-10-12_05-18-36",
        startMs: 1_750_000_000_000,
        liveTitle: "开播啦",
        mergeSegments: false,
        uploadMode: "stage",
        stageDir,
        uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像", titleTemplate: "{name}_{date}" },
        uploadPrivate: true,
      },
    };
  }
  const workOf = (sub: string, i: number): string => join(sub, ".work", `${String(i).padStart(3, "0")}.mp4`);
  const canonicalOf = (sub: string, i: number): string => join(sub, `Lilt_2026-10-12_${String(i).padStart(3, "0")}.mp4`);

  it("逐段产出与 .work 中间产物**同 inode**(零额外空间),上传物 = 规范名", async () => {
    const { sub, spec } = scene();
    const r = await runNodeSidePipeline(spec, silence);

    expect(r.ok).toBe(true);
    expect(r.products).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const canonical = canonicalOf(sub, i);
      expect(existsSync(canonical)).toBe(true);
      expect(r.products![i]).toBe(canonical);
      // 同一 inode = 同一份数据(改前是两个不同 inode 的真副本)。
      expect(statSync(canonical).ino).toBe(statSync(workOf(sub, i)).ino);
      expect(statSync(canonical).nlink).toBe(2);
      expect(readFileSync(canonical, "utf-8")).toBe("REMUXED");
    }
  });

  it("linkSync 抛错(跨设备/不支持硬链接)→ 回落复制:内容一致、inode 不同", async () => {
    const { sub, spec } = scene();
    linkFail.on = true;
    try {
      const r = await runNodeSidePipeline(spec, silence);

      expect(r.ok).toBe(true);
      for (let i = 0; i < 3; i++) {
        const canonical = canonicalOf(sub, i);
        expect(existsSync(canonical)).toBe(true);
        expect(statSync(canonical).ino).not.toBe(statSync(workOf(sub, i)).ino); // 真复制
        expect(readFileSync(canonical, "utf-8")).toBe("REMUXED");
      }
    } finally {
      linkFail.on = false; // 别把打桩泄漏给后面的用例
    }
  });

  it("续跑:规范名已存在 → 不重复 remux、inode 不变(改成 rename/mv 会让重跑重做一遍)", async () => {
    const { sub, spec } = scene();
    const r1 = await runNodeSidePipeline(spec, silence);
    expect(r1.ok).toBe(true);
    const inos = [0, 1, 2].map((i) => statSync(canonicalOf(sub, i)).ino);

    // 再跑一遍(等价「中断重跑」):.work 与规范名都在 → 全部跳过。
    const r2 = await runNodeSidePipeline(spec, silence);
    expect(r2.ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(statSync(canonicalOf(sub, i)).ino).toBe(inos[i]); // 没被重建
      expect(statSync(canonicalOf(sub, i)).ino).toBe(statSync(workOf(sub, i)).ino);
    }
  });
});


/**
 * A1/A2/A3 issue #2 收口回归。
 *
 *  - A1「尽早落盘」:进入 remux **之前**先写 `started` → 执行体在 remux 阶段就被终止/抛错时,
 *    master 回读仍能看到 `started`(而非 null),据此区分「已接管未建稿」。
 *  - A3 幂等重入:落盘结果已有 bv → **绝不重复 uploadPlain 建稿**(B站不可逆),
 *    只按 countVideoParts 续未确认的分 P;确认不了 → 抛错转人工;done+bv → 整场跳过。
 *  - A2 pid/cmdline:abortNodeExecutor 经注入 deps 安全终止,cmdline 不匹配绝不误杀。
 */
describe("issue #2 A1:started 在 remux 之前落盘(执行体中途死仍可见)", () => {
  // 同文件内 vi.fn 不会自动清零(见 issue#6 用例已调用 remuxSegment)→ 每次先清,
  // 保证「未调用」断言只反映本次管线调用。
  beforeEach(() => {
    vi.mocked(remuxSegment).mockClear();
    vi.mocked(uploadPlain).mockClear();
    vi.mocked(appendGroup).mockClear();
    vi.mocked(countVideoParts).mockClear();
  });

  function uploadScene(): { stageDir: string; sub: string; spec: Parameters<typeof runNodeSidePipeline>[0] } {
    const root = mkdtempSync(join(tmpdir(), "node-a1-"));
    const recDir = join(root, "recordings");
    mkdirSync(recDir, { recursive: true });
    const tsFiles = [0, 1, 2].map((i) => {
      const f = join(recDir, `Lilt_2026-10-12_05-18-36_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(f, "src");
      return f;
    });
    const stageDir = join(root, "stage");
    mkdirSync(stageDir, { recursive: true });
    return {
      stageDir,
      sub: join(stageDir, "douyin_123_2026-10-12"),
      spec: {
        streamKey: "douyin:123:2026-10-12",
        tsFiles,
        sessionBase: "Lilt_2026-10-12_05-18-36",
        startMs: 1_750_000_000_000,
        liveTitle: "开播啦",
        mergeSegments: false,
        uploadMode: "upload",
        stageDir,
        uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像", titleTemplate: "{name}_{date}" },
        uploadPrivate: true,
      },
    };
  }

  it("remux 阶段抛错 → 落盘停在 started(不是 null,master 可区分「已接管未建稿」)", async () => {
    const { sub, spec } = uploadScene();
    vi.mocked(remuxSegment).mockImplementationOnce(() => { throw new Error("remux boom"); });
    await expect(runNodeSidePipeline(spec, silence)).rejects.toThrow(/remux boom/);
    const r = readNodeResult(sub);
    expect(r?.phase).toBe("started"); // started 写在 produceParts 之前 → 中途死也留痕
    expect(r?.bv).toBeUndefined();    // started 不代表已建稿
  });

  it("执行体接管即写 pid 文件(.drec-node-executor.pid)供 _node-abort 定位", async () => {
    const { sub, spec } = uploadScene();
    vi.mocked(remuxSegment).mockImplementationOnce(() => { throw new Error("remux boom"); });
    await expect(runNodeSidePipeline(spec, silence)).rejects.toThrow();
    // 中途抛错(未经 removeNodeExecutorPid 路径)→ pid 文件仍在 → master 能定位并终止。
    expect(existsSync(nodeExecutorPidPath(sub))).toBe(true);
  });
});

describe("issue #2 A3:执行体幂等重入(有 bv 绝不重复建稿)", () => {
  // 同文件内 vi.fn 不会自动清零(见 issue#6 用例已调用 remuxSegment)→ 每次先清,
  // 保证「未调用」断言只反映本次管线调用。
  beforeEach(() => {
    vi.mocked(remuxSegment).mockClear();
    vi.mocked(uploadPlain).mockClear();
    vi.mocked(appendGroup).mockClear();
    vi.mocked(countVideoParts).mockClear();
  });

  function scene(): { sub: string; spec: Parameters<typeof runNodeSidePipeline>[0]; gate: UploadGate } {
    const root = mkdtempSync(join(tmpdir(), "node-a3-"));
    const recDir = join(root, "recordings");
    mkdirSync(recDir, { recursive: true });
    const tsFiles = [0, 1, 2].map((i) => {
      const f = join(recDir, `Lilt_2026-10-12_07-00-00_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(f, "src");
      return f;
    });
    const stageDir = join(root, "stage");
    mkdirSync(stageDir, { recursive: true });
    const c = clock();
    const store = openUploadLimitStore(join(root, "x.db"), { log: silence });
    const gate = new UploadGate({ store, cooldownMs: 0, rateLimit: 1000, now: c.now, sleep: c.sleep, warn: silence });
    return {
      sub: join(stageDir, "douyin_123_2026-10-13"),
      spec: {
        streamKey: "douyin:123:2026-10-13",
        tsFiles,
        sessionBase: "Lilt_2026-123",
        startMs: 1_750_000_000_000,
        liveTitle: "开播啦",
        mergeSegments: false,
        uploadMode: "upload",
        stageDir,
        uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像", titleTemplate: "{name}_{date}" },
        uploadPrivate: true,
      } as unknown as Parameters<typeof runNodeSidePipeline>[0],
      gate,
    };
  }

  it("done + bv 落盘 → 整场跳过(remux/upload/append 都不调用)", async () => {
    const { sub, spec, gate } = scene();
    writeNodeResult(sub, { phase: "done", ok: true, bv: "BV1DONE", products: ["/p1.mp4"] }, silence);
    const r = await runNodeSidePipeline(spec, silence, gate);
    expect(r).toEqual({ ok: true, bv: "BV1DONE", products: ["/p1.mp4"] });
    expect(vi.mocked(uploadPlain)).not.toHaveBeenCalled();
    expect(vi.mocked(appendGroup)).not.toHaveBeenCalled();
    expect(vi.mocked(remuxSegment)).not.toHaveBeenCalled(); // 跳过 remux
    expect(existsSync(nodeExecutorPidPath(sub))).toBe(false); // 早返回清理陈旧 pid
  });

  it("failed + bv 落盘 + countVideoParts=2 → 跳过建稿、只续第 3 个分 P(绝不重复 uploadPlain)", async () => {
    const { sub, spec, gate } = scene();
    vi.mocked(uploadPlain).mockClear();
    vi.mocked(appendGroup).mockClear();
    writeNodeResult(sub, { phase: "failed", ok: false, bv: "BV1OLD", error: "append 挂在 2/3" }, silence);
    vi.mocked(countVideoParts).mockResolvedValueOnce(2);
    const r = await runNodeSidePipeline(spec, silence, gate);
    expect(r.ok).toBe(true);
    expect(r.bv).toBe("BV1OLD");                    // 复用稿件,不新建
    expect(vi.mocked(uploadPlain)).not.toHaveBeenCalled(); // 幂等核心:绝不重复建稿
    expect(vi.mocked(appendGroup)).toHaveBeenCalledTimes(1); // 只补 parts[2](分 P 3)
    expect(vi.mocked(countVideoParts)).toHaveBeenCalledWith("BV1OLD", expect.any(String));
    const final = readNodeResult(sub);
    expect(final?.phase).toBe("done");
    expect(final?.bv).toBe("BV1OLD");
  });

  it("failed + bv 但 countVideoParts=null(确认不了已建到第几)→ 抛错转人工、绝不重复建稿", async () => {
    const { sub, spec, gate } = scene();
    vi.mocked(uploadPlain).mockClear();
    writeNodeResult(sub, { phase: "failed", ok: false, bv: "BV1X", error: "append 中断" }, silence);
    vi.mocked(countVideoParts).mockResolvedValueOnce(null);
    await expect(runNodeSidePipeline(spec, silence, gate)).rejects.toThrow(/转人工|无法确认/);
    expect(vi.mocked(uploadPlain)).not.toHaveBeenCalled(); // 既不盲目 append 也不重建稿
    // 抛错前已落 failed 且保留 bv(不抹掉建稿证据)→ master 仍判「已建稿、绝不重传」。
    const r = readNodeResult(sub);
    expect(r?.phase).toBe("failed");
    expect(r?.bv).toBe("BV1X");
  });

  it("无 bv 的 started 重入 → 正常新建稿并推进终态(started 不是「已建稿」证据)", async () => {
    const { sub, spec, gate } = scene();
    vi.mocked(uploadPlain).mockClear();
    writeNodeResult(sub, { phase: "started", ok: false }, silence); // 上次 remux 前死、没建稿
    const r = await runNodeSidePipeline(spec, silence, gate);
    expect(r.ok).toBe(true);
    expect(vi.mocked(uploadPlain)).toHaveBeenCalledTimes(1); // 没建过稿 → 安全新建
    expect(readNodeResult(sub)?.phase).toBe("done"); // started 已推进为终态
  });

  it("#59:每次 appendGroup 都带 countParts,且回读的是本稿件 bv + 本机 cookies 路径", async () => {
    const { sub, spec, gate } = scene();
    vi.mocked(uploadPlain).mockClear();
    vi.mocked(appendGroup).mockClear();
    vi.mocked(countVideoParts).mockClear();
    vi.mocked(uploadPlain).mockResolvedValueOnce("BV1CNT");
    const r = await runNodeSidePipeline(spec, silence, gate);
    expect(r.ok).toBe(true);
    const calls = vi.mocked(appendGroup).mock.calls as unknown as Array<[{ bv: string; countParts?: () => Promise<number | null> }]>;
    expect(calls.length).toBeGreaterThan(0);
    for (const [o] of calls) {
      expect(o.bv).toBe("BV1CNT");
      expect(typeof o.countParts, "缺 countParts 则追加结果不确定时无法幂等核对").toBe("function");
    }
    await calls[0]![0].countParts!();
    expect(vi.mocked(countVideoParts)).toHaveBeenLastCalledWith("BV1CNT", expect.any(String));
    expect(readNodeResult(sub)?.phase).toBe("done");
  });

  it("#59:append 结果不确定(抛 ambiguous)→ 不重试、落 failed+bv 转人工,只调一次", async () => {
    const { sub, spec, gate } = scene();
    vi.mocked(uploadPlain).mockClear();
    vi.mocked(appendGroup).mockReset();
    vi.mocked(uploadPlain).mockResolvedValueOnce("BV1AMB");
    const err = new Error("[append-ambiguous] append 结果不确定,需人工核对");
    vi.mocked(appendGroup).mockRejectedValueOnce(err);
    await expect(runNodeSidePipeline(spec, silence, gate)).rejects.toThrow(/不确定|人工/);
    expect(vi.mocked(appendGroup)).toHaveBeenCalledTimes(1); // 绝不重复追加
    const r = readNodeResult(sub);
    expect(r?.phase).toBe("failed");
    expect(r?.bv).toBe("BV1AMB");
    vi.mocked(appendGroup).mockImplementation(async () => {});
  });
});

describe("issue #2 A2:abortNodeExecutor(经注入 deps 安全终止,绝不误杀)", () => {
  it("无 pid 文件 → aborted=true(节点已应答且本场无执行体:未启动或已收尾)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abort-"));
    const killed: Array<[number, string | number]> = [];
    const res = await abortNodeExecutor(dir, "douyin:1:2026-10-12", {
      readCmdline: () => null, listChildren: () => [], kill: (pid, sig) => { killed.push([pid, sig]); return true; },
    }, async () => {}, 0);
    // pid 文件是执行体的登记表:`_node-abort` 能应答 = 节点可达;无 pid = 本场没有(也不会再有)执行体。
    expect(res.aborted).toBe(true);
    expect(res.detail).toContain("无 pid 文件");
    expect(killed).toHaveLength(0); // 无从杀起,绝不发任何信号
  });

  it("stage 子目录不存在 → aborted=false(可能不是执行体真正的落盘位置,不确定不定为「确已停」)", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "abort-parent-")), "no-such-stage-sub");
    const killed: Array<[number, string | number]> = [];
    const res = await abortNodeExecutor(missing, "douyin:1:2026-10-12", {
      readCmdline: () => null, listChildren: () => [], kill: (pid, sig) => { killed.push([pid, sig]); return true; },
    }, async () => {}, 0);
    // 假 `aborted:true` 会让 master 把 started 判成「确认没成 failed」= 静默分裂复发 → 必须保守 false。
    expect(res.aborted).toBe(false);
    expect(res.detail).toContain("不确定");
    expect(killed).toHaveLength(0);
  });

  it("pid 存活但 cmdline 不匹配 → aborted=true 且**不发任何 kill**(防 pid 回收误杀)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abort-"));
    writeFileSync(join(dir, ".drec-node-executor.pid"), "4242");
    const killed: Array<[number, string | number]> = [];
    const res = await abortNodeExecutor(dir, "douyin:1:2026-10-12", {
      readCmdline: () => ["node", "other.js"], // 不是本场 _node-pipeline
      listChildren: () => [], kill: (pid, sig) => { killed.push([pid, sig]); return true; },
    }, async () => {}, 0);
    expect(res.aborted).toBe(true);
    expect(res.detail).toContain("不误杀");
    expect(killed.filter(([, sig]) => sig !== 0)).toHaveLength(0); // 除存活探测外无 kill
  });

  it("cmdline 匹配本场 streamKey → SIGTERM→SIGKILL 连同子进程一并终止", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abort-"));
    writeFileSync(join(dir, ".drec-node-executor.pid"), "4242");
    const spec = Buffer.from(JSON.stringify({ streamKey: "douyin:1:2026-10-12" })).toString("base64");
    const alive = new Set([4242, 99]); // 父 + 一个子(biliup/ffmpeg)
    const sigs: Array<[number, string | number]> = [];
    const res = await abortNodeExecutor(dir, "douyin:1:2026-10-12", {
      readCmdline: () => ["node", "dist/douyin-rec.mjs", "_node-pipeline", "/data", spec],
      listChildren: () => [99],
      kill: (pid, sig) => { sigs.push([pid, sig]); if (sig === "SIGKILL") alive.delete(pid); return alive.has(pid); },
    }, async () => {}, 0);
    expect(res.aborted).toBe(true);
    expect(res.killed).toEqual(expect.arrayContaining([4242, 99])); // 父与子都在目标内
    // SIGTERM 先发给父与子,随后 SIGKILL 兜底
    expect(sigs.some(([p, s]) => s === "SIGTERM" && p === 99)).toBe(true);
    expect(sigs.some(([p, s]) => s === "SIGKILL" && p === 4242)).toBe(true);
  });

  it("pid 存活但读不到 cmdline(非 Linux/权限)→ aborted=false(不确定,调用方保守)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abort-"));
    writeFileSync(join(dir, ".drec-node-executor.pid"), "4242");
    const res = await abortNodeExecutor(dir, "douyin:1:2026-10-12", {
      readCmdline: () => null, listChildren: () => [], kill: (pid, sig) => sig === 0,
    }, async () => {}, 0);
    expect(res.aborted).toBe(false);
  });

  it("isExecutorCmdline:base64 spec 比对 streamKey,精确身份防误杀", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    expect(isExecutorCmdline(["node", "x", "_node-pipeline", "/d", enc({ streamKey: "a:1:2" })], "a:1:2")).toBe(true);
    expect(isExecutorCmdline(["node", "x", "_node-pipeline", "/d", enc({ streamKey: "a:1:2" })], "z:9:9")).toBe(false);
    expect(isExecutorCmdline(["node", "x", "other"], "a:1:2")).toBe(false); // 无 _node-pipeline
    expect(isExecutorCmdline(null, "a:1:2")).toBe(false);
  });
});
