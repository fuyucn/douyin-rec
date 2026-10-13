import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RollingUploader } from "./rolling-upload.js";
import { UploadGate, rollingUploadSingleNode } from "@drec/core";

/** 记录一次上传用的假 gate(no-op store,不落盘、不冷却)。 */
class FakeGate extends UploadGate {
  async run<T>(_key: string, fn: () => Promise<T>): Promise<T> { return fn(); }
}

function mkSession(names: string[]): { dir: string; paths: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "rolling-test-"));
  mkdirSync(path.join(dir, "rec"), { recursive: true });
  const paths = names.map((n) => {
    const p = path.join(dir, "rec", n);
    writeFileSync(p, "x");
    return p;
  });
  return { dir, paths };
}

/** 生成同会话的一组分段文件名(共享 session base = `主播_2026-06-27_08-00-00`)。 */
const segNames = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `主播_2026-06-27_08-00-00_${String(i).padStart(3, "0")}.ts`);

const room = { platform: "douyin", roomSlug: "123" };
const uploadMeta = { tag: "直播", tid: 21 };
const noopAppend = async (): Promise<void> => {};
// 测试里用 removeFile 接缝阻止真实删盘(只断言调用),避免污染 tmp。
const noRemove = (): boolean => false;
// mtime 与 now 可能差 1~2ms(文件系统时钟),让「录制已收尾」的封口判定稳定成立。
const futureNow = (): number => Date.now() + 60_000;
// 与 segNames 同构的会话 base(读 sidecar / 崩溃恢复测试用)。
const SESSION_BASE = "主播_2026-06-27_08-00-00";
const sidecarPath = (dir: string): string => path.join(dir, "rec", `${SESSION_BASE}.rolling.json`);
function writeSidecar(dir: string, overrides: Record<string, unknown>): void {
  writeFileSync(
    sidecarPath(dir),
    JSON.stringify({
      streamKey: `douyin:123:${SESSION_BASE}`,
      sessionBase: SESSION_BASE,
      segments: [],
      confirmed: [],
      updatedAt: Date.now(),
      ...overrides,
    }),
  );
}

describe("RollingUploader — 边录边传录制端执行", () => {
  it("只处理封口段:有后继段的旧段上传+删,正在写的最近段不动", async () => {
    const { paths } = mkSession(segNames(3));
    const up = vi.fn(async () => "BV1aaaaaaaaa");
    const remove = vi.fn(noRemove);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: remove, now: futureNow, minSegmentSec: 0 });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: true });
    // 段 0/1 有后继 → 封口;段 2(正在写)不封口。
    expect(r.uploaded.sort()).toEqual([0, 1]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith(paths[0]);
    expect(remove).toHaveBeenCalledWith(paths[1]);
    expect(remove).not.toHaveBeenCalledWith(paths[2]);
    expect(u.bv).toBe("BV1aaaaaaaaa");
  });

  // 回归(实测 e2e 复现):生产路径**不传** now / 不传封口宽限,收尾那一轮必须上传并删掉末段。
  // 旧实现沿用 DEFAULT_SEAL_GRACE_MS(3s):刚写完就收尾的末段 mtime 距今 < 3s → 判不出封口
  // → 末段永不上传、源永残留(master 见「有 rolling.bv 但仍有 ts」→ 整场转人工)。
  it("默认路径收尾 flush:末段(刚写完)必须上传并删源 —— 不依赖任何宽限等待", async () => {
    const { paths } = mkSession(segNames(1));
    const up = vi.fn(async () => "BV1greaceregr");
    const remove = vi.fn(() => true);
    // 不传 now(真 Date.now → 末段 mtime 距今约 0ms)/ 不传任何宽限。
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: remove, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0]);
    expect(u.bv).toBe("BV1greaceregr");
    expect(remove).toHaveBeenCalledWith(paths[0]); // 末段源必须被清掉,不留残段
    // 收尾后的第二段也要跟上(多段流:最后一轮把尾段也传完)。
    const s2 = mkSession(segNames(2));
    const ap = vi.fn(async () => {});
    const remove2 = vi.fn(() => true);
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove2, minSegmentSec: 0 });
    for (const p of s2.paths) u2.noteSegment(p);
    const r2 = await u2.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([0, 1]);
    expect(remove2).toHaveBeenCalledWith(s2.paths[1]);
  });

  it("单段 + 已收尾 → 最后一个封口段也上传;重启读 sidecar 不重复建稿", async () => {
    const { paths } = mkSession(segNames(1));
    const up = vi.fn(async () => "BV1bbbbbbbbb");
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u1.noteSegment(paths[0]);
    const r1 = await u1.flush({ recordingActive: false });
    expect(r1.uploaded).toEqual([0]);
    expect(up).toHaveBeenCalledTimes(1);

    // 新实例 = 进程重启:sidecar 已记录确认,绝不再建稿。
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u2.noteSegment(paths[0]);
    const r2 = await u2.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([]);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("append 失败 → 记 ambiguous、保留源,后续轮不自动重传", async () => {
    const { paths } = mkSession(segNames(2));
    const up = vi.fn(async () => "BV1ccccccccccc");
    const ap = vi.fn(async () => { throw new Error("network down"); });
    const remove = vi.fn(noRemove);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, minSegmentSec: 0 });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0]);   // 段 0 建稿成功
    expect(r.ambiguous).toContain(1);  // 段 1 append 失败 → 人工
    expect(remove).toHaveBeenCalledTimes(1);
    // 已记 ambiguous 的段不自动重试。
    const r2 = await u.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([]);
    expect(ap).toHaveBeenCalledTimes(1);
  });

  it("重启后新段从 max+1 续号(不复用已确认段号 → 不漏传新段)", async () => {
    const { paths } = mkSession(segNames(2));
    const up = vi.fn(async () => "BV1dddddddddd");
    const ap = vi.fn(async () => {});
    // 第一轮:段 0 建稿并确认(段 1 是"最新"→ 未封口,不上传)。
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u1.noteSegment(paths[0]);
    await u1.flush({ recordingActive: false });
    expect(u1.confirmedIndices).toEqual([0]);

    // 重启(新实例,读 sidecar):新段 s_001 必须分到段号 1 并 append(而不是复用 0 被跳过)。
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u2.noteSegment(paths[1]);
    const r2 = await u2.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([1]);
    expect(ap).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledTimes(1); // 建稿仍只发生过一次
  });

  it("头阻塞:中间段失败后,其后的段不再上传(不可逆空洞防线)", async () => {
    const { paths } = mkSession(segNames(3));
    const up = vi.fn(async () => "BV1hhhhhhhhhh");
    const ap = vi.fn(async () => { throw new Error("network down"); });
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: false });
    // 段 0 建稿成功;段 1 失败 → 段 2 必须被挡回(否则 P2 后的 P3 会留下不可补的空洞)。
    expect(r.uploaded).toEqual([0]);
    expect(r.ambiguous).toContain(1);
    expect(ap).toHaveBeenCalledTimes(1); // 只尝试过段 1,段 2 未被调用
    // 下一轮:段 1 仍 ambiguous → 段 2 继续被挡(头阻塞保持)。
    const r2 = await u.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([]);
    expect(ap).toHaveBeenCalledTimes(1);
  });

  it("碎片段:封口段时长不足 → 不上传、保留源、不阻塞后续段", async () => {
    const { paths } = mkSession(segNames(3));
    const t0 = Date.now() - 60_000;
    utimesSync(paths[0], new Date(t0), new Date(t0));
    utimesSync(paths[1], new Date(t0 + 1_000), new Date(t0 + 1_000)); // 距上段 1s < 5s → 碎片
    utimesSync(paths[2], new Date(t0 + 21_000), new Date(t0 + 21_000)); // 距上段 20s → 正常
    const up = vi.fn(async () => "BV1ffffffffff");
    const ap = vi.fn(async () => {});
    const remove = vi.fn(noRemove);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, minSegmentSec: 5 });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0, 2]); // 段 1 碎片跳过
    expect(ap).toHaveBeenCalledTimes(1); // 只 append 传段 2
    expect(remove).not.toHaveBeenCalledWith(paths[1]);
    // 第二轮不再重复日志/上传。
    const r2 = await u.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([]);
  });

  it("可见性:默认「仅自己可见」,唯一 override = uploadPrivate:false", async () => {
    const { paths } = mkSession(segNames(1));
    const up = vi.fn(async (_o: { plain: { public?: boolean } }) => "BV1pppppppppp");
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    await u.flush({ recordingActive: false });
    expect(up.mock.calls[0]?.[0].plain.public).toBe(false); // 默认 → 私密(public=false → --is-only-self)

    // 独立会话(另一 sidecar),避免读到上一实例的已确认状态而走 append(不建稿)。
    const { paths: paths2 } = mkSession(segNames(1));
    const up2 = vi.fn(async (_o: { plain: { public?: boolean } }) => "BV1qqqqqqqqqq");
    const u2 = new RollingUploader({ room, uploadMeta, uploadPrivate: false, gate: new FakeGate(), uploadPlainRaw: up2, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u2.noteSegment(paths2[0]);
    await u2.flush({ recordingActive: false });
    expect(up2.mock.calls[0]?.[0].plain.public).toBe(true); // 显式公开
  });

  it("崩溃恢复:create 中断(BV 未知)→ 转人工,绝不自动重建稿", async () => {
    const { dir, paths } = mkSession(segNames(1));
    writeSidecar(dir, { segments: [{ index: 0, path: paths[0] }], uploading: { index: 0, kind: "create" } });
    const up = vi.fn(async () => "BV1zzzzzzzzzz");
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(u.ambiguousIndices).toContain(0);
    expect(up).not.toHaveBeenCalled(); // 绝不自动重建稿(重复投稿不可逆)
    expect(r.uploaded).toEqual([]);
  });

  it("崩溃恢复:append 已提交(分P数=confirmed+1)→ 补确认,不重传", async () => {
    const { dir, paths } = mkSession(segNames(2));
    writeSidecar(dir, {
      segments: [{ index: 0, path: paths[0] }, { index: 1, path: paths[1] }],
      confirmed: [0],
      bv: "BV1rrrrrrrrrr",
      uploading: { index: 1, kind: "append" },
    });
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: async () => "BV1rrrrrrrrrr", appendGroupRaw: ap, countPartsRaw: async () => 2, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(u.confirmedIndices).toEqual([0, 1]); // 补确认
    expect(ap).not.toHaveBeenCalled();          // 结果已提交,不重复 append
    expect(r.uploaded).toEqual([]);
  });

  it("崩溃恢复:append 未提交(分P数=confirmed)→ 清意图,安全重试", async () => {
    const { dir, paths } = mkSession(segNames(2));
    writeSidecar(dir, {
      segments: [{ index: 0, path: paths[0] }, { index: 1, path: paths[1] }],
      confirmed: [0],
      bv: "BV1ssssssssss",
      uploading: { index: 1, kind: "append" },
    });
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: async () => "BV1ssssssssss", appendGroupRaw: ap, countPartsRaw: async () => 1, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(ap).toHaveBeenCalledTimes(1); // 未提交 → 正常重试
    expect(r.uploaded).toEqual([1]);
  });

  // 碎片段被跳过(minSegmentSec)的会话里 confirmed **天然非连续**(如 0,2)。崩溃恢复只能认分 P 数
  // 这一条证据 —— 若额外要求段号连续,会把这种正常情况误判成人工干预 → 无谓转人工。
  it("崩溃恢复:碎片段导致 confirmed 非连续,仍按分P数补确认(不误转人工)", async () => {
    const { dir, paths } = mkSession(segNames(4));
    const t0 = Date.now() - 600_000;
    utimesSync(paths[0], new Date(t0), new Date(t0));
    utimesSync(paths[1], new Date(t0 + 1_000), new Date(t0 + 1_000));       // 距上段 1s < 5s → 碎片段
    utimesSync(paths[2], new Date(t0 + 301_000), new Date(t0 + 301_000));
    utimesSync(paths[3], new Date(t0 + 601_000), new Date(t0 + 601_000));
    writeSidecar(dir, {
      // 段 1 曾是碎片段(未上传);已确认 = 0,2;段 3 的 append 结果未知(进程被杀)。
      segments: paths.map((p, i) => ({ index: i, path: p })),
      confirmed: [0, 2],
      bv: "BV1ffffragment",
      uploading: { index: 3, kind: "append" },
    });
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: async () => "BV1ffffragment", appendGroupRaw: ap, countPartsRaw: async () => 3, removeFile: noRemove, now: futureNow, minSegmentSec: 5 });
    u.noteSegment(paths[0]);
    await u.flush({ recordingActive: false });
    expect(u.confirmedIndices).toEqual([0, 2, 3]); // 分P数=3=已确认数+1 → 段 3 其实已提交
    expect(u.ambiguousIndices).toEqual([]);
    expect(ap).not.toHaveBeenCalled();              // 段 3 已提交 / 段 1 是碎片段 → 一次 append 都没有
  });

  it("崩溃恢复:append 分P数异常 → 转人工,不重传", async () => {
    const { dir, paths } = mkSession(segNames(2));
    writeSidecar(dir, {
      segments: [{ index: 0, path: paths[0] }, { index: 1, path: paths[1] }],
      confirmed: [0],
      bv: "BV1tttttttttt",
      uploading: { index: 1, kind: "append" },
    });
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: async () => "BV1tttttttttt", appendGroupRaw: ap, countPartsRaw: async () => 5, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(u.ambiguousIndices).toContain(1);
    expect(ap).not.toHaveBeenCalled();
    expect(r.uploaded).toEqual([]);
  });

  // 分 P 数**查不到**（接口抖动/审核中/解析失败）≠「未提交」:绝不能据此重试 append,
  // 否则可能重复投稿。必须保守转人工。
  it("崩溃恢复:append 分P数查不到(null)→ 转人工,不猜重传", async () => {
    const { dir, paths } = mkSession(segNames(2));
    writeSidecar(dir, {
      segments: [{ index: 0, path: paths[0] }, { index: 1, path: paths[1] }],
      confirmed: [0],
      bv: "BV1nnnnnnnnnn",
      uploading: { index: 1, kind: "append" },
    });
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: async () => "BV1nnnnnnnnnn", appendGroupRaw: ap, countPartsRaw: async () => null, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(u.ambiguousIndices).toContain(1);
    expect(ap).not.toHaveBeenCalled();
    expect(r.uploaded).toEqual([]);
  });

  // 崩溃窗口:「已确认(acked)但删源前被杀」→ 重启首轮必须补删该段源,否则磁盘水位闸门
  // 会被已传完的段长期占住(边录边传的核心目的落空)。
  it("崩溃恢复:确认后未删源 → 重启补删(不重传)", async () => {
    const { dir, paths } = mkSession(segNames(2));
    writeSidecar(dir, {
      segments: [{ index: 0, path: paths[0] }, { index: 1, path: paths[1] }],
      confirmed: [0, 1],
      bv: "BV1cccccccccc",
      uploading: { index: 1, kind: "append" }, // 确认后、销标记前被杀
    });
    const up = vi.fn(async () => "BV1cccccccccc");
    const ap = vi.fn(async () => {});
    const remove = vi.fn(() => true);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, minSegmentSec: 0 });
    u.noteSegment(paths[0]);
    const r = await u.flush({ recordingActive: false });
    expect(u.confirmedIndices).toEqual([0, 1]); // 不重复确认
    expect(up).not.toHaveBeenCalled();          // 已有 BV → 绝不重建稿
    expect(ap).not.toHaveBeenCalled();          // 已提交 → 绝不重复 append
    expect(remove).toHaveBeenCalledTimes(2);    // 两个已确认段的源都补删
    expect(r.uploaded).toEqual([]);
  });

  // sidecar 是「已传/已确认」的唯一持久化证据。原子写失败 → 幂等状态不可信:此后**绝不**外发
  // 上传、绝不删源(否则重复投稿 + 销毁唯一副本都不可逆),只能转人工。
  // 用真实的目录权限故障注入(把分段目录设为只读 → WAL 临时文件 openSync 必失败),不靠假接缝。
  it("sidecar 写失败 → 状态不可信:不建稿、不 append、不删源,并明示转人工", async () => {
    const { dir, paths } = mkSession(segNames(1));
    const up = vi.fn(async () => "BV1uuuuuuuuuu");
    const ap = vi.fn(async () => {});
    const remove = vi.fn(noRemove);
    const logs: string[] = [];
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, minSegmentSec: 0, log: (m) => logs.push(m) });
    u.noteSegment(paths[0]); // 此时目录仍可写:正常落 sidecar
    const recDir = path.join(dir, "rec");
    chmodSync(recDir, 0o500); // 只读 → 之后的原子写必然失败
    try {
      const r = await u.flush({ recordingActive: false });
      expect(r.uploaded).toEqual([]);
      expect(up).not.toHaveBeenCalled();   // WAL 意图落盘失败 → 绝不允许外发建稿
      expect(ap).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled(); // 源必须保留
      expect(logs.some((m) => m.includes("sidecar 原子写失败") && m.includes("转人工"))).toBe(true);
      // 后续轮次保持停摆(不会「下一轮又试一次」造成重复投稿)。
      const r2 = await u.flush({ recordingActive: false });
      expect(r2.uploaded).toEqual([]);
      expect(up).not.toHaveBeenCalled();
    } finally {
      chmodSync(recDir, 0o755); // 恢复权限,留待系统清理 tmp
    }
  });
});

describe("rollingUploadSingleNode — 跨节点重复投稿闸门(纯函数)", () => {
  it("无规则(单机 / 未编排)→ 允许", () => {
    expect(rollingUploadSingleNode(false, undefined)).toBe(true);
  });
  it("规则存在但未写 workers(= 全部节点)→ 拒绝", () => {
    expect(rollingUploadSingleNode(true, undefined)).toBe(false);
    expect(rollingUploadSingleNode(true, [])).toBe(false);
  });
  it("规则勾选恰好 1 个节点 → 允许", () => {
    expect(rollingUploadSingleNode(true, ["vps2"])).toBe(true);
  });
  it("规则勾选 ≥2 个节点 → 拒绝", () => {
    expect(rollingUploadSingleNode(true, ["vps1", "vps2"])).toBe(false);
  });
});
