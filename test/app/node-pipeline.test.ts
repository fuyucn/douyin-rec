/**
 * T19:节点侧上传共限流持久化 601 冷却 —— node-pipeline 的上传路径必须过 core UploadGate。
 *
 * 覆盖:① 命中 601 → 冷却跨「重启」(新 gate 实例 + 新 store 实例)保留;
 *      ② 冷却期内节点侧上传被阻塞;③ 账号键解析(与 master 同键/异键);
 *      ④ master 与节点共享同一限流状态文件时,总提交数不超 rateLimit(并发场景)。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadGate, openUploadLimitStore, biliAccountKeyFromCookiesJson } from "@drec/core";
import { nodeStageCleanupTargets, openNodeUploadGate, planGroups, prepareNodeUploadAlias, readNodeResult, resolveUploadAccountKey, splitGroupsBySession, writeNodeResult } from "../../packages/app/src/node-pipeline.js";

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
