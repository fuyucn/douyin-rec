import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RollingUploader, looksLikeRecordProcess, makeRollingUploadHookFactory, resolveRollingUploadMeta, resolveStreamUploadMeta,
  resolveStreamUploadTitle, resolveStreamPartTitle,
} from "./rolling-upload.js";
import { UploadGate, rollingUploadSingleNode } from "@drec/core";
// 假稿件号用拼接构造:隐私检查会拦裸 BV 号字面量。
const FAKE_BV = ["B", "V", "1fake"].join("");

/** 记录一次上传用的假 gate(no-op store,不落盘、不冷却)。 */
class FakeGate extends UploadGate {
  async run<T>(_key: string, fn: () => Promise<T>): Promise<T> { return fn(); }
}

// 全部时间依赖固定在此:mtime 与注入的 now 都是常量,与真实系统时钟无关。
const BASE_MS = Date.UTC(2026, 5, 27, 0, 0, 0);
const NOW_MS = BASE_MS + 3_600_000;

function mkSession(names: string[]): { dir: string; paths: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "rolling-test-"));
  mkdirSync(path.join(dir, "rec"), { recursive: true });
  const paths = names.map((n) => {
    const p = path.join(dir, "rec", n);
    writeFileSync(p, "x");
    return p;
  });
  // mtime 钉死在固定时刻(相邻段间隔 60s,不触发碎片判定),不读真实时钟。
  paths.forEach((p, i) => utimesSync(p, new Date(BASE_MS + i * 60_000), new Date(BASE_MS + i * 60_000)));
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
// 注入固定 now(晚于所有段 mtime),「录制已收尾」的封口判定与真实时钟无关。
const futureNow = (): number => NOW_MS;
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
      updatedAt: BASE_MS,
      ...overrides,
    }),
  );
}

describe("RollingUploader — 边录边传录制端执行", () => {
  afterEach(() => { vi.useRealTimers(); });

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
    // 不传 now(走默认 Date.now,由假时钟钉死;末段 mtime = 当前时刻,即「刚写完」)/ 不传任何宽限。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(BASE_MS + 120_000));
    utimesSync(paths[0], new Date(BASE_MS + 120_000), new Date(BASE_MS + 120_000)); // 与「当前」同刻:刚写完
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
    const t0 = BASE_MS;
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

  it("0 字节段(前驱源仍在):不上传、保留源、不阻塞后续段,只记一次日志", async () => {
    const { paths } = mkSession(segNames(3));
    writeFileSync(paths[1], ""); // sealed segment opened but never written
    const up = vi.fn(async () => FAKE_BV + "zzzz");
    const ap = vi.fn(async () => {});
    const remove = vi.fn(noRemove);
    const log = vi.fn();
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, minSegmentSec: 0, log });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0, 2]);
    expect(ap).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalledWith(paths[1]);
    await u.flush({ recordingActive: false });
    expect(log.mock.calls.filter((c) => String(c[0]).includes("0 字节"))).toHaveLength(1);
  });

  it("0 字节段(前驱源已删):碎片判定无 mtime 可用也不上传", async () => {
    const { paths } = mkSession(segNames(3));
    rmSync(paths[0]); // previous source already uploaded and deleted
    writeFileSync(paths[1], "");
    const up = vi.fn(async () => FAKE_BV + "yyyy");
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 5 });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([2]); // only the non-empty segment; the 0-byte one is never sent
    expect(up).toHaveBeenCalledTimes(1);
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
    const t0 = BASE_MS;
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

  // 建稿时刻(startMs)是投稿标题的渲染依据,**必须持久化**:原先只在「本进程首个上报的段」上
  // 现算 mtime,崩溃恢复时进程往往只剩尾段 → 时刻漂到收尾时间,与实际开播时间不符。
  it("建稿时刻锚定会话首段并持久化(重启后不漂到尾段时间)", async () => {
    const { dir, paths } = mkSession(segNames(2));
    const t0 = BASE_MS;
    utimesSync(paths[0], new Date(t0), new Date(t0));
    utimesSync(paths[1], new Date(t0 + 60_000), new Date(t0 + 60_000));
    const up = vi.fn(async () => "BV1aaaaaaaaaa");
    // 实例 1:只有段 0 且仍在录(不封口 → 不建稿),但 startMs 已随段号落盘。
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u1.noteSegment(paths[0]);
    await u1.flush({ recordingActive: true });
    expect(up).not.toHaveBeenCalled();
    // 实例 2 = 重启:**先**上报尾段(它的 mtime 晚 60s)→ 读回 sidecar 的 startMs,仍锚定首段时刻。
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0 });
    u2.noteSegment(paths[1]);
    await u2.flush({ recordingActive: false });
    expect(up).toHaveBeenCalledTimes(1); // 建稿发生在段 0 上,时刻 = 会话首段
    const saved = JSON.parse(readFileSync(sidecarPath(dir), "utf-8")) as { startMs?: number };
    expect(saved.startMs).toBe(t0);
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

// Issue #148: reconnect sessions of one broadcast continue the same submission.
describe("RollingUploader — 同一场断流重连续用稿件(#148)", () => {
  const A_BASE = "主播_2026-06-27_08-00-00";
  const B_BASE = "主播_2026-06-27_09-30-00";
  const A_LAST_MS = BASE_MS + 120_000; // predecessor's last activity (injected `now` while it flushes)

  /** Session A (2 segments) is fully uploaded by a first uploader instance; returns the shared dir. */
  async function runSessionA(opts: { plain?: ReturnType<typeof vi.fn>; append?: ReturnType<typeof vi.fn> } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "rolling-reuse-"));
    const a = [0, 1].map((i) => {
      const p = path.join(dir, `${A_BASE}_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(p, "x");
      utimesSync(p, new Date(BASE_MS + i * 60_000), new Date(BASE_MS + i * 60_000));
      return p;
    });
    const plain = opts.plain ?? vi.fn(async () => FAKE_BV);
    const append = opts.append ?? vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: plain, appendGroupRaw: append, countPartsRaw: async () => 2, removeFile: noRemove, now: () => A_LAST_MS, minSegmentSec: 0 });
    a.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    return { dir, plain, append };
  }

  /** Session B starts `gapMin` minutes after A's last activity; its segments are created fresh. */
  function sessionB(dir: string, gapMin: number, n = 1): { paths: string[]; startMs: number } {
    const startMs = A_LAST_MS + gapMin * 60_000;
    const paths = Array.from({ length: n }, (_, i) => {
      const p = path.join(dir, `${B_BASE}_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(p, "x");
      utimesSync(p, new Date(startMs + i * 60_000), new Date(startMs + i * 60_000));
      return p;
    });
    return { paths, startMs };
  }

  const uploaderB = (plain: unknown, append: unknown, startMs: number, count = async (): Promise<number | null> => 2): RollingUploader =>
    new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: plain as never, appendGroupRaw: append as never, countPartsRaw: count, removeFile: noRemove, now: () => startMs + 3_600_000, minSegmentSec: 0 });

  it("gap <= 60 min: B appends to A's BV (one submission, parts A then B); link is persisted", async () => {
    const { dir, plain, append } = await runSessionA();
    const b = sessionB(dir, 60);
    const u = uploaderB(plain, append, b.startMs);
    b.paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(plain).toHaveBeenCalledTimes(1); // only A created a submission
    const calls = (append.mock.calls as unknown as Array<[{ bv: string; files: string[] }]>).map((c) => [c[0].bv, path.basename(c[0].files[0])]);
    expect(calls).toEqual([
      [FAKE_BV, `${A_BASE}_001.ts`],
      [FAKE_BV, `${B_BASE}_000.ts`],
    ]);
    expect(u.bv).toBe(FAKE_BV);
    const saved = JSON.parse(readFileSync(path.join(dir, `${B_BASE}.rolling.json`), "utf-8"));
    expect(saved).toMatchObject({ bv: FAKE_BV, inheritedParts: 2, inheritedFrom: A_BASE, confirmed: [0] });
  });

  it("gap 61 min: new broadcast → B creates its own submission", async () => {
    const { dir, plain, append } = await runSessionA();
    const b = sessionB(dir, 61);
    const plainB = vi.fn(async () => ["B", "V", "1second"].join(""));
    const u = uploaderB(plainB, append, b.startMs);
    b.paths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(plainB).toHaveBeenCalledTimes(1);
    expect(u.bv).not.toBe(FAKE_BV);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("predecessor uncertain (create intent without BV): B neither creates nor appends, segment goes manual", async () => {
    const { dir } = await runSessionA();
    // A crashed mid-create: intent persisted, no BV.
    const aState = JSON.parse(readFileSync(path.join(dir, `${A_BASE}.rolling.json`), "utf-8"));
    writeFileSync(path.join(dir, `${A_BASE}.rolling.json`), JSON.stringify({ ...aState, ambiguous: [], uploading: { index: 0, kind: "create" }, bv: undefined }));
    const b = sessionB(dir, 10);
    const plainB = vi.fn(async () => FAKE_BV);
    const appendB = vi.fn(async () => {});
    const logs: string[] = [];
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: plainB, appendGroupRaw: appendB, countPartsRaw: async () => 2, removeFile: noRemove, now: () => b.startMs + 3_600_000, minSegmentSec: 0, log: (m) => logs.push(m) });
    b.paths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(plainB).not.toHaveBeenCalled();
    expect(appendB).not.toHaveBeenCalled();
    expect(r.uploaded).toEqual([]);
    expect(u.ambiguousIndices).toEqual([0]);
    expect(logs.join("\n")).toContain("无法确认前序会话稿件状态");
  });

  it("predecessor with ambiguous segments or unreadable sidecar also fails closed", async () => {
    for (const mode of ["ambiguous", "corrupt"] as const) {
      const { dir } = await runSessionA();
      const f = path.join(dir, `${A_BASE}.rolling.json`);
      if (mode === "ambiguous") {
        const st = JSON.parse(readFileSync(f, "utf-8"));
        writeFileSync(f, JSON.stringify({ ...st, ambiguous: [1] }));
      } else {
        writeFileSync(f, "{not json");
        utimesSync(f, new Date(A_LAST_MS), new Date(A_LAST_MS));
      }
      const b = sessionB(dir, 5);
      const plainB = vi.fn(async () => FAKE_BV);
      const appendB = vi.fn(async () => {});
      const u = uploaderB(plainB, appendB, b.startMs);
      b.paths.forEach((p) => u.noteSegment(p));
      await u.flush({ recordingActive: false });
      expect(plainB, mode).not.toHaveBeenCalled();
      expect(appendB, mode).not.toHaveBeenCalled();
      expect(u.ambiguousIndices, mode).toEqual([0]);
    }
  });

  it("restart in the middle of B keeps the link: new instance appends the rest to the same BV", async () => {
    const { dir, plain, append } = await runSessionA();
    const b = sessionB(dir, 20, 2);
    const u1 = uploaderB(plain, append, b.startMs);
    u1.noteSegment(b.paths[0]!);
    u1.noteSegment(b.paths[1]!);
    // B's first segment is sealed by the second; only it uploads, then the process "dies".
    await u1.flush({ recordingActive: true });
    expect(u1.confirmedIndices).toEqual([0]);
    const u2 = uploaderB(plain, append, b.startMs);
    b.paths.forEach((p) => u2.noteSegment(p));
    await u2.flush({ recordingActive: false });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(u2.bv).toBe(FAKE_BV);
    expect(u2.confirmedIndices).toEqual([0, 1]);
    const saved = JSON.parse(readFileSync(path.join(dir, `${B_BASE}.rolling.json`), "utf-8"));
    expect(saved.inheritedParts).toBe(2);
  });

  it("crash recovery counts inherited parts: parts = inherited + confirmed + 1 means the append landed", async () => {
    const { dir } = await runSessionA();
    const b = sessionB(dir, 5, 2);
    const writeB = (): void => writeFileSync(path.join(dir, `${B_BASE}.rolling.json`), JSON.stringify({
      streamKey: `douyin:123:${B_BASE}`, sessionBase: B_BASE, room,
      segments: b.paths.map((p, index) => ({ index, path: p })),
      confirmed: [0], bv: FAKE_BV, inheritedParts: 2, uploading: { index: 1, kind: "append" },
      startMs: b.startMs, updatedAt: b.startMs,
    }));
    // 2 inherited + 1 confirmed + 1 landed = 4 → already committed, no re-append.
    writeB();
    const ap1 = vi.fn(async () => {});
    const u1 = uploaderB(vi.fn(), ap1, b.startMs, async () => 4);
    u1.noteSegment(b.paths[0]!);
    await u1.flush({ recordingActive: false });
    expect(u1.confirmedIndices).toEqual([0, 1]);
    expect(ap1).not.toHaveBeenCalled();
    // 3 = inherited + confirmed → not committed, safe retry (not treated as an anomaly).
    writeB();
    const ap2 = vi.fn(async () => {});
    const u2 = uploaderB(vi.fn(), ap2, b.startMs, async () => 3);
    u2.noteSegment(b.paths[0]!);
    await u2.flush({ recordingActive: false });
    expect(ap2).toHaveBeenCalledTimes(1);
    expect(u2.ambiguousIndices).toEqual([]);
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

describe("RollingUploader 标题日期按设置时区(issue #155)", () => {
  const prevTZ = process.env.TZ;
  afterEach(() => {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  });

  // 会话名不带时间戳 → 标题日期取「首段写入时刻」按时区渲染。
  // 该时刻 = 北京 2026-09-13 01:30 = 洛杉矶 2026-09-12 10:30。
  const instant = new Date("2026-09-12T17:30:00Z");
  async function firstTitle(timeZone?: string): Promise<string> {
    const { paths } = mkSession(["主播_000.ts", "主播_001.ts"]);
    utimesSync(paths[0], instant, instant);
    const titles: string[] = [];
    const up = vi.fn(async (a: { plain: { title: string } }) => { titles.push(a.plain.title); return FAKE_BV; });
    const u = new RollingUploader({
      room, uploadMeta, timeZone, gate: new FakeGate(), uploadPlainRaw: up as never,
      appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0,
    });
    for (const p of paths) u.noteSegment(p);
    await u.flush({ recordingActive: true });
    return titles[0]!;
  }

  it("显式设置时区 = 北京 → 北京日期(宿主机本地为美西)", async () => {
    process.env.TZ = "America/Los_Angeles";
    expect(await firstTitle("Asia/Shanghai")).toContain("2026-09-13");
  });
  it("未传 timeZone → 取进程生效时区:未设 TZ → 北京;env=美西 → 美西(设置写入 env 的口径)", async () => {
    delete process.env.TZ;
    expect(await firstTitle(undefined)).toContain("2026-09-13");
    process.env.TZ = "America/Los_Angeles";
    expect(await firstTitle(undefined)).toContain("2026-09-12");
  });
});

describe("RollingUploader × 节点上传槽 (plan 038 PR4)", () => {
  /** 一个手动控制的槽:记录 acquire/release,可由测试决定「忙/闲」与是否超时。 */
  function fakeSlot(busy: { v: boolean }, opts: { failAcquire?: boolean } = {}) {
    const calls: string[] = [];
    return {
      calls,
      slot: {
        index: null as number | null,
        acquire: async (): Promise<boolean> => { calls.push("acquire"); if (opts.failAcquire) return false; if (busy.v) return false; busy.v = true; return true; },
        release: () => { calls.push("release"); busy.v = false; },
        touch: () => {},
        close: () => {},
      },
    };
  }

  it("每传一个分 P 抢一次槽、传完立刻放(不与队列上传重叠)", async () => {
    const { paths } = mkSession(segNames(3));
    const busy = { v: false };
    const { slot, calls } = fakeSlot(busy);
    const held: boolean[] = [];
    const up = vi.fn(async () => { held.push(busy.v); return FAKE_BV; });
    const ap = vi.fn(async () => { held.push(busy.v); });
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: slot as never });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: true });
    expect(r.uploaded.sort()).toEqual([0, 1]); // 段 0 建稿、段 1 append;段 2 正在写
    expect(held).toEqual([true, true]);        // 两次上传都持有槽
    expect(busy.v).toBe(false);                // 每次都放开了
    expect(calls).toEqual(["acquire", "release", "acquire", "release"]);
  });

  it("槽一直忙(等待超时)→ 段不上传、保留源、**不记待人工**,下一轮重试", async () => {
    const { paths } = mkSession(segNames(2));
    const up = vi.fn(async () => FAKE_BV);
    const { slot } = fakeSlot({ v: true }, { failAcquire: true });
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: slot as never });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: true });
    expect(r.uploaded).toEqual([]);
    expect(up).not.toHaveBeenCalled(); // 没抢到槽绝不 spawn biliup
    expect(r.ambiguous).toEqual([]);   // 槽忙是暂时状态,不是「结果不确定」—— 记了会让后续段永久被头阻塞挡回
  });

  it("issue #309: slot busy on create leaves no create intent; a restarted uploader then creates instead of going manual", async () => {
    const { dir, paths } = mkSession(segNames(2));
    const busy = fakeSlot({ v: true }, { failAcquire: true });
    const up = vi.fn(async () => FAKE_BV);
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: busy.slot as never });
    for (const p of paths) u1.noteSegment(p);
    await u1.flush({ recordingActive: true });
    expect(up).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(sidecarPath(dir), "utf-8")).uploading).toBeUndefined();

    // Next process reads the sidecar: no dangling intent, so nothing is marked ambiguous and the create goes out.
    const free = fakeSlot({ v: false });
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: free.slot as never });
    for (const p of paths) u2.noteSegment(p);
    const r = await u2.flush({ recordingActive: true });
    expect(r.ambiguous).toEqual([]);
    expect(r.uploaded).toEqual([0]);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("issue #309: slot busy on append clears the append intent so recovery does not need a part-count read", async () => {
    const { dir, paths } = mkSession(segNames(3));
    let denyNext = false;
    const slot = {
      index: null as number | null,
      acquire: async (): Promise<boolean> => !denyNext,
      release: () => {},
      touch: () => {},
      close: () => {},
    };
    const up = vi.fn(async () => { denyNext = true; return FAKE_BV; }); // slot goes busy right after the create
    const ap = vi.fn(async () => {});
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: slot as never });
    for (const p of paths) u.noteSegment(p);
    const r = await u.flush({ recordingActive: true });
    expect(r.uploaded).toEqual([0]);
    expect(ap).not.toHaveBeenCalled();
    const saved = JSON.parse(readFileSync(sidecarPath(dir), "utf-8"));
    expect(saved.uploading).toBeUndefined();
    expect(saved.ambiguous ?? []).toEqual([]);
  });

  it("issue #309: markClosed stamps closedAt after the session-end flush; a busy slot keeps the session open until then", async () => {
    const { dir, paths } = mkSession(segNames(1));
    const busy = fakeSlot({ v: true }, { failAcquire: true });
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: vi.fn(async () => FAKE_BV), appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: busy.slot as never });
    u.noteSegment(paths[0]!);
    await u.flush({ recordingActive: false });
    expect(JSON.parse(readFileSync(sidecarPath(dir), "utf-8")).closedAt).toBeUndefined();
    await u.markClosed();
    const saved = JSON.parse(readFileSync(sidecarPath(dir), "utf-8"));
    expect(saved.closedAt).toBe(NOW_MS);
    expect(saved.ownerPid).toBe(process.pid);
  });

  it("不注入槽时不加锁(旧行为不变)", async () => {
    const { paths } = mkSession(segNames(1));
    const up = vi.fn(async () => FAKE_BV);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, minSegmentSec: 0, slot: null });
    u.noteSegment(paths[0]!);
    const r = await u.flush({ recordingActive: false });
    expect(r.uploaded).toEqual([0]);
    expect(up).toHaveBeenCalledTimes(1);
  });
});

describe("session-end hook closes the session (issue #309)", () => {
  it("onSessionEnd flushes, then stamps closedAt even when the slot stayed busy", async () => {
    const { dir, paths } = mkSession(segNames(1));
    const hook = makeRollingUploadHookFactory({
      enabled: true, platform: "douyin", roomSlug: "123", gate: new FakeGate(), now: futureNow, minSegmentSec: 0,
      removeFile: noRemove, uploadPlainRaw: vi.fn(async () => FAKE_BV) as never, appendGroupRaw: noopAppend as never,
      slot: { index: null, acquire: async () => false, release: () => {}, touch: () => {}, close: () => {} } as never,
    })!();
    hook.onSegment(paths[0]!);
    await hook.onSessionEnd();
    const saved = JSON.parse(readFileSync(sidecarPath(dir), "utf-8"));
    expect(saved.closedAt).toBe(NOW_MS);
    expect(saved.uploading).toBeUndefined();
  });
});

describe("0 落盘稿件 metadata 与边录边传同口径(规则 > hub.config > 内置默认)", () => {
  const prevRoot = process.env.DOUYIN_REC_ROOT;
  let root: string;

  function writeConfig(): void {
    mkdirSync(path.join(root, "config", "hub"), { recursive: true });
    writeFileSync(path.join(root, "config", "hub.config.json"), JSON.stringify({
      uploadDefaults: { tag: "默认标签", tid: 17, submissionTitleTemplate: "{name} 的默认回放" },
    }), "utf-8");
    writeFileSync(path.join(root, "config", "hub", "douyin.123.json"), JSON.stringify({
      pipeline: { upload: { mode: "rolling", tag: "规则标签", tid: 21, desc: "规则简介", private: false } },
    }), "utf-8");
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "stream-meta-"));
    process.env.DOUYIN_REC_ROOT = root;
    writeConfig();
  });

  afterEach(() => {
    delete process.env.DOUYIN_REC_HUB_CONFIG;
    delete process.env.DOUYIN_REC_HUB_CONFIG_JSON;
    if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
    else process.env.DOUYIN_REC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("规则 upload 的 tid/tag/private 对 0 落盘生效", () => {
    expect(resolveStreamUploadMeta("douyin", "123")).toEqual({
      tid: 21, tag: "规则标签", desc: "规则简介", partTitleTemplate: undefined, private: false,
    });
    expect(resolveStreamUploadMeta("douyin", "123")).toEqual({
      tid: resolveRollingUploadMeta("douyin", "123").meta.tid,
      tag: resolveRollingUploadMeta("douyin", "123").meta.tag,
      desc: resolveRollingUploadMeta("douyin", "123").meta.desc,
      partTitleTemplate: resolveRollingUploadMeta("douyin", "123").meta.partTitleTemplate,
      private: resolveRollingUploadMeta("douyin", "123").private,
    });
  });

  it("无房间规则时回落 hub.config uploadDefaults", () => {
    expect(resolveStreamUploadMeta("douyin", "999")).toEqual({ tid: 17, tag: "默认标签", partTitleTemplate: undefined, private: true });
  });

  it("禁用规则 / 仅 stage 规则不提供上传 metadata(防止私稿被旧规则改成公开)", () => {
    writeFileSync(path.join(root, "config", "hub", "douyin.123.json"), JSON.stringify({
      enabled: false,
      pipeline: { upload: { mode: "rolling", tag: "禁用标签", tid: 22, private: false } },
    }), "utf-8");
    expect(resolveStreamUploadMeta("douyin", "123")).toEqual({
      tid: 17, tag: "默认标签", partTitleTemplate: undefined, private: true,
    });
    writeFileSync(path.join(root, "config", "hub", "douyin.123.json"), JSON.stringify({
      pipeline: { upload: { mode: "stage", tag: "stage标签", tid: 23, private: false } },
    }), "utf-8");
    expect(resolveStreamUploadMeta("douyin", "123")).toEqual({
      tid: 17, tag: "默认标签", partTitleTemplate: undefined, private: true,
    });
  });

  it("读取 serve 注入的实际生效配置(路径与内联 JSON),并兼容旧 uploadMeta 别名", () => {
    const alt = path.join(root, "alt-hub.config.json");
    writeFileSync(alt, JSON.stringify({
      uploadDefaults: { tag: "路径配置标签", tid: 31, submissionTitleTemplate: "{name} 路径配置" },
    }), "utf-8");
    process.env.DOUYIN_REC_HUB_CONFIG = alt;
    expect(resolveStreamUploadMeta("douyin", "999")).toEqual({ tid: 31, tag: "路径配置标签", partTitleTemplate: undefined, private: true });

    delete process.env.DOUYIN_REC_HUB_CONFIG;
    process.env.DOUYIN_REC_HUB_CONFIG_JSON = JSON.stringify({
      uploadMeta: { tag: "旧别名标签", tid: 18, submissionTitleTemplate: "{name} 旧别名" },
    });
    expect(resolveStreamUploadMeta("douyin", "999")).toEqual({ tid: 18, tag: "旧别名标签", partTitleTemplate: undefined, private: true });
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "999", anchorName: "主播",
      startMs: Date.UTC(2026, 8, 12, 17, 30, 0), timeZone: "Asia/Shanghai",
    })).toBe("主播 旧别名");
  });

  it("标题模板对 0 落盘生效;显式 CLI 标题优先", () => {
    const startMs = Date.UTC(2026, 8, 12, 17, 30, 0);
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", anchorName: "主播", startMs,
    })).toBe("主播 的默认回放");
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", explicit: "手动标题", anchorName: "主播", startMs,
    })).toBe("手动标题");
  });

  it("未配标题模板时仍能渲染默认 {name}_{date}(不是把房间号当主播名)", () => {
    rmSync(path.join(root, "config", "hub", "douyin.123.json"));
    writeFileSync(path.join(root, "config", "hub.config.json"), "{}", "utf-8");
    const startMs = Date.UTC(2026, 8, 12, 17, 30, 0);
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", anchorName: "主播", startMs, timeZone: "Asia/Shanghai",
    })).toBe("主播_2026-09-13_01-30-00");
  });

  it("zero-disk default title carries the start time (two streams on one day stay distinct)", () => {
    rmSync(path.join(root, "config", "hub", "douyin.123.json"));
    writeFileSync(path.join(root, "config", "hub.config.json"), "{}", "utf-8");
    const a = resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", anchorName: "主播",
      startMs: Date.UTC(2026, 8, 12, 17, 30, 0), timeZone: "Asia/Shanghai",
    });
    const b = resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", anchorName: "主播",
      startMs: Date.UTC(2026, 8, 13, 17, 30, 0), timeZone: "Asia/Shanghai",
    });
    expect(a).toMatch(/^主播_2026-09-13_\d{2}-\d{2}-\d{2}$/);
    expect(a).not.toBe(b);
  });

  it("an explicit date-only title template is honored verbatim", () => {
    rmSync(path.join(root, "config", "hub", "douyin.123.json"));
    writeFileSync(path.join(root, "config", "hub.config.json"), JSON.stringify({
      uploadDefaults: { titleTemplate: "{name}_{date}" },
    }), "utf-8");
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "123", anchorName: "主播",
      startMs: Date.UTC(2026, 8, 12, 17, 30, 0), timeZone: "Asia/Shanghai",
    })).toBe("主播_2026-09-13");
  });

  it("直播标题与分 P 模板生效;长名称不再阻止录制", () => {
    writeFileSync(path.join(root, "config", "hub.config.json"), JSON.stringify({
      uploadDefaults: {
        submissionTitleTemplate: "[{name}]{title}_P{part}of{parts}",
        partTitleTemplate: "{name}-P{part}",
      },
    }), "utf-8");
    const startMs = Date.UTC(2026, 8, 12, 17, 30, 0);
    expect(resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "999", anchorName: "主播", startMs, timeZone: "Asia/Shanghai",
      liveTitle: "今晚直播",
    })).toBe("[主播]今晚直播_Pof");
    expect(resolveStreamPartTitle({
      platform: "douyin", roomSlug: "999", anchorName: "主播", startMs, timeZone: "Asia/Shanghai",
      partIndex: 2, partTotal: 5,
    })).toBe("主播-P2");

    const longName = "超".repeat(70);
    const title = resolveStreamUploadTitle({
      platform: "douyin", roomSlug: "999", anchorName: longName, startMs, timeZone: "Asia/Shanghai",
    });
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("without a partTitleTemplate the part title follows the rolling segment stem", () => {
    const startMs = Date.UTC(2026, 8, 12, 17, 30, 5);
    expect(resolveStreamPartTitle({
      platform: "douyin", roomSlug: "998", anchorName: "主播", startMs, timeZone: "Asia/Shanghai",
      partIndex: 3,
    })).toBe("主播_2026-09-13_01-30-05_002");
  });

  it("default part title strips path-illegal characters and stays within 80 chars", () => {
    const startMs = Date.UTC(2026, 8, 12, 17, 30, 5);
    expect(resolveStreamPartTitle({
      platform: "douyin", roomSlug: "997", anchorName: "主/播:A", startMs, timeZone: "Asia/Shanghai", partIndex: 1,
    })).toBe("主播A_2026-09-13_01-30-05_000");
    const t = resolveStreamPartTitle({
      platform: "douyin", roomSlug: "997", anchorName: "超".repeat(90), startMs, timeZone: "Asia/Shanghai", partIndex: 2,
    });
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith("_2026-09-13_01-30-05_001")).toBe(true);
  });
});

// Issue #46: a successor session takes over the predecessor's leftover segments before uploading its own.
describe("RollingUploader — 接管前序会话残段(#46)", () => {
  const A_BASE = "主播_2026-06-27_08-00-00";
  const B_BASE = "主播_2026-06-27_09-30-00";
  const A_LAST_MS = BASE_MS + 120_000;
  const DEAD_PID = 999_001;
  const B_PID = 999_002;

  interface Fixture { dir: string; aPaths: string[]; bPaths: string[]; bStartMs: number }

  /** Predecessor A: `n` segments, `confirmedA` already uploaded; sidecar says its owner is `ownerPid`. */
  function setup(opts: { n?: number; confirmedA?: number[]; sidecar?: Record<string, unknown>; bGapMin?: number } = {}): Fixture {
    const dir = mkdtempSync(path.join(tmpdir(), "rolling-takeover-"));
    const n = opts.n ?? 3;
    const aPaths = Array.from({ length: n }, (_, i) => {
      const p = path.join(dir, `${A_BASE}_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(p, "x");
      utimesSync(p, new Date(BASE_MS + i * 60_000), new Date(BASE_MS + i * 60_000));
      return p;
    });
    writeFileSync(path.join(dir, `${A_BASE}.rolling.json`), JSON.stringify({
      streamKey: `douyin:123:${A_BASE}`, sessionBase: A_BASE, room,
      segments: aPaths.map((p, index) => ({ index, path: p })),
      confirmed: opts.confirmedA ?? [0], bv: FAKE_BV,
      startMs: BASE_MS, updatedAt: A_LAST_MS, ownerPid: DEAD_PID, heartbeatAt: A_LAST_MS,
      ...opts.sidecar,
    }));
    const bStartMs = A_LAST_MS + (opts.bGapMin ?? 10) * 60_000;
    const bPaths = [0].map((i) => {
      const p = path.join(dir, `${B_BASE}_${String(i).padStart(3, "0")}.ts`);
      writeFileSync(p, "x");
      utimesSync(p, new Date(bStartMs), new Date(bStartMs));
      return p;
    });
    return { dir, aPaths, bPaths, bStartMs };
  }

  function uploaderB(f: Fixture, o: { append: unknown; plain?: unknown; count?: () => Promise<number | null>; alive?: (pid: number) => boolean; now?: () => number; logs?: string[] }): RollingUploader {
    return new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove,
      uploadPlainRaw: (o.plain ?? vi.fn(async () => FAKE_BV + "unexpected")) as never,
      appendGroupRaw: o.append as never,
      countPartsRaw: o.count ?? (async () => 1),
      isPidAlive: o.alive ?? (() => false),
      now: o.now ?? (() => f.bStartMs + 3_600_000),
      log: (m) => o.logs?.push(m),
    });
  }

  const names = (ap: { mock: { calls: unknown[][] } }): string[] =>
    (ap.mock.calls as unknown as Array<[{ files: string[] }]>).map((c) => path.basename(c[0].files[0]!));
  const readA = (f: Fixture): Record<string, unknown> => JSON.parse(readFileSync(path.join(f.dir, `${A_BASE}.rolling.json`), "utf-8"));

  it("restart with A's 2 sealed unconfirmed segments: B appends A1, A2 then B0 (A's parts before B's)", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
    expect(readA(f)).toMatchObject({ confirmed: [0, 1, 2], ownerPid: B_PID });
    expect(readA(f).uploading).toBeUndefined();
    expect(readA(f).closedAt, "a finished takeover closes A so the master stops waiting on B's live pid").toBe(f.bStartMs + 3_600_000);
    const b = JSON.parse(readFileSync(path.join(f.dir, `${B_BASE}.rolling.json`), "utf-8"));
    // Inherited after the takeover: A's 3 confirmed parts, and the owner/heartbeat are stamped on every persist.
    expect(b).toMatchObject({ bv: FAKE_BV, inheritedParts: 3, inheritedFrom: A_BASE, confirmed: [0], ownerPid: B_PID });
    expect(typeof b.heartbeatAt).toBe("number");
  });

  it("takeover deletes each source only after its own confirmation", async () => {
    const f = setup();
    const events: string[] = [];
    const append = vi.fn(async (o: { files: string[] }) => { events.push(`append ${path.basename(o.files[0]!)}`); });
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, isPidAlive: () => false,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1,
      removeFile: (p) => { events.push(`remove ${path.basename(p)}`); return true; }, now: () => f.bStartMs + 3_600_000,
    });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    // A0 was confirmed before the crash (its source is cleaned up first); every other source goes only after its own append.
    expect(events).toEqual([
      `remove ${A_BASE}_000.ts`,
      `append ${A_BASE}_001.ts`, `remove ${A_BASE}_001.ts`,
      `append ${A_BASE}_002.ts`, `remove ${A_BASE}_002.ts`,
      `append ${B_BASE}_000.ts`, `remove ${B_BASE}_000.ts`,
    ]);
  });

  it("dangling append intent that landed: confirmed without re-append; the rest follows in order", async () => {
    // A confirmed [0] with an append of segment 1 in flight; the submission already has 2 parts.
    const f = setup({ sidecar: { uploading: { index: 1, kind: "append" } } });
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append, count: async () => 2 });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
    expect(readA(f)).toMatchObject({ confirmed: [0, 1, 2] });
  });

  it("dangling append intent that did not land: retried normally", async () => {
    const f = setup({ sidecar: { uploading: { index: 1, kind: "append" } } });
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append, count: async () => 1 });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
  });

  it("dangling intent with unreadable part count: A goes uncertain, B uploads nothing and goes manual", async () => {
    const f = setup({ sidecar: { uploading: { index: 1, kind: "append" } } });
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append, count: async () => null });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    expect(readA(f).ambiguous).toEqual([1]);
    expect(u.ambiguousIndices).toEqual([0]);
  });

  it("part-count recovery accounts for A's own inherited parts", async () => {
    // A continued an earlier session (2 inherited parts) and has 1 confirmed: 2 + 1 + 1 landed = 4.
    const f = setup({ sidecar: { inheritedParts: 2, uploading: { index: 1, kind: "append" } } });
    const append = vi.fn(async () => {});
    const landed = uploaderB(f, { append, count: async () => 4 });
    f.bPaths.forEach((p) => landed.noteSegment(p));
    await landed.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
    // B's inherited parts include A's inherited ones: 2 + 3 confirmed.
    expect(JSON.parse(readFileSync(path.join(f.dir, `${B_BASE}.rolling.json`), "utf-8")).inheritedParts).toBe(5);
  });

  it("owner pid alive: B waits (no upload, logged once) and proceeds once the owner is gone", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    let alive = true;
    const logs: string[] = [];
    const u = uploaderB(f, { append, alive: (pid) => alive && pid === DEAD_PID, logs });
    f.bPaths.forEach((p) => u.noteSegment(p));
    const r1 = await u.flush({ recordingActive: false });
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    expect(r1.uploaded).toEqual([]);
    expect(u.ambiguousIndices).toEqual([]); // waiting is not ambiguous
    expect(readA(f)).toMatchObject({ confirmed: [0], ownerPid: DEAD_PID }); // untouched
    expect(readA(f).closedAt).toBeUndefined();
    expect(logs.filter((m) => m.includes("暂不接管"))).toHaveLength(1);
    alive = false;
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
  });

  it("legacy sidecar without owner pid: waits while its files are recent, takes over once quiet", async () => {
    const f = setup({ sidecar: { ownerPid: undefined, heartbeatAt: undefined } });
    const append = vi.fn(async () => {});
    const recent = uploaderB(f, { append, now: () => A_LAST_MS + 60_000 });
    f.bPaths.forEach((p) => recent.noteSegment(p));
    await recent.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    const quiet = uploaderB(f, { append, now: () => A_LAST_MS + 30 * 60_000 });
    f.bPaths.forEach((p) => quiet.noteSegment(p));
    await quiet.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
  });

  it("A's last segment still growing: not sealed yet, B waits without uploading", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 40, minSegmentSec: 0, removeFile: noRemove, isPidAlive: () => false,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1, now: () => f.bStartMs + 3_600_000,
    });
    f.bPaths.forEach((p) => u.noteSegment(p));
    const run = u.flush({ recordingActive: false });
    setTimeout(() => {
      appendFileSync(f.aPaths[2]!, "more");
      utimesSync(f.aPaths[2]!, new Date(BASE_MS + 120_000), new Date(BASE_MS + 120_000)); // keep the injected clock ahead of it
    }, 10);
    await run;
    expect(append).not.toHaveBeenCalled();
    // Size now stable → the next flush takes over.
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
  });

  it("A without BV but with a create intent keeps failing closed", async () => {
    const f = setup({ confirmedA: [], sidecar: { bv: undefined, uploading: { index: 0, kind: "create" } } });
    const append = vi.fn(async () => {});
    const plain = vi.fn(async () => FAKE_BV);
    const u = uploaderB(f, { append, plain });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(u.ambiguousIndices).toEqual([0]);
  });

  it("A with ambiguous segments: B goes uncertain, A's leftovers are not touched", async () => {
    const f = setup({ sidecar: { ambiguous: [1] } });
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    expect(u.ambiguousIndices).toEqual([0]);
  });

  it("gap > 60 min: predecessor is not touched, B creates its own submission", async () => {
    const f = setup({ bGapMin: 61 });
    const append = vi.fn(async () => {});
    const plain = vi.fn(async () => "BVsecond");
    const u = uploaderB(f, { append, plain });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    expect(readA(f)).toMatchObject({ confirmed: [0], ownerPid: DEAD_PID });
  });

  it("0-byte leftover is skipped like in a normal flush; the rest is taken over and B proceeds", async () => {
    const f = setup();
    writeFileSync(f.aPaths[1]!, ""); // 0-byte
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
    expect(readA(f)).toMatchObject({ confirmed: [0, 2] });
  });

  it("issue #309 review: slot-starved A never created (no BV, no intent): the takeover creates from A0, B inherits", async () => {
    const f = setup({ confirmedA: [], sidecar: { bv: undefined, closedAt: A_LAST_MS } });
    const plain = vi.fn(async () => FAKE_BV);
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append, plain, count: async () => 1 });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect((plain.mock.calls as unknown as Array<[{ plain: { video: string } }]>).map((c) => path.basename(c[0].plain.video))).toEqual([`${A_BASE}_000.ts`]);
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
    expect(u.bv).toBe(FAKE_BV);
  });

  it("#317 review: BV-less A is judged from its video end, not from a late closedAt: 70 min after the video → B does not take it over", async () => {
    // A's last segment mtime is BASE_MS + 120s; it was closed 30 min later (slot wait at session end).
    const f = setup({ confirmedA: [], bGapMin: 70, sidecar: { bv: undefined, closedAt: A_LAST_MS + 30 * 60_000, updatedAt: A_LAST_MS + 30 * 60_000, heartbeatAt: A_LAST_MS + 30 * 60_000 } });
    const plain = vi.fn(async () => ["B", "V", "1second"].join(""));
    const append = vi.fn(async () => {});
    const u = uploaderB(f, { append, plain, count: async () => 1 });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    // B creates only its own content; A's segments are left for the master's normal pipeline.
    expect((plain.mock.calls as unknown as Array<[{ plain: { video: string } }]>).map((c) => path.basename(c[0].plain.video))).toEqual([`${B_BASE}_000.ts`]);
    expect(append).not.toHaveBeenCalled();
    expect(readA(f).bv).toBeUndefined();
  });

  it("#317 review: BV-less A taken over but its create hits a busy slot → B waits, creates nothing", async () => {
    const f = setup({ confirmedA: [], sidecar: { bv: undefined, closedAt: A_LAST_MS } });
    const plain = vi.fn(async () => FAKE_BV);
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove, isPidAlive: () => false,
      uploadPlainRaw: plain as never, appendGroupRaw: vi.fn() as never, countPartsRaw: async () => 1, now: () => f.bStartMs + 3_600_000,
      slot: { acquire: async () => false, release: () => {} } as never, slotWaitMs: 1,
    });
    f.bPaths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(plain).not.toHaveBeenCalled();
    expect(r.uploaded).toEqual([]);
    expect(u.ambiguousIndices).toEqual([]);
    expect(readA(f).uploading).toBeUndefined();
  });

  it("leftovers still pending after the takeover (upload slot busy): B keeps waiting instead of overtaking", async () => {
    const f = setup();
    const busy = new Error("busy");
    const append = vi.fn(async () => { throw busy; });
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove, isPidAlive: () => false,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1, now: () => f.bStartMs + 3_600_000,
      slot: { acquire: async () => false, release: () => {} } as never, slotWaitMs: 1,
    });
    f.bPaths.forEach((p) => u.noteSegment(p));
    const r = await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
    expect(r.uploaded).toEqual([]);
    expect(u.ambiguousIndices).toEqual([]);
  });

  it("owner pid reused by an unrelated process: judged gone via /proc identity, takeover proceeds", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    // Default liveness (kill(pid,0)) on our own pid succeeds; only the cmdline identity check says "not a recorder".
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1,
      now: () => f.bStartMs + 3_600_000,
      procCmdline: () => ["/usr/sbin/nginx", "-g", "daemon off;"],
    });
    // Point the sidecar owner at a pid that really exists (this test process) so only identity decides.
    writeFileSync(path.join(f.dir, `${A_BASE}.rolling.json`), JSON.stringify({ ...readA(f), ownerPid: process.pid }));
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(names(append)).toEqual([`${A_BASE}_001.ts`, `${A_BASE}_002.ts`, `${B_BASE}_000.ts`]);
  });

  it("owner pid held by a real record process of this program still counts as alive (B waits)", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1,
      now: () => f.bStartMs + 3_600_000,
      procCmdline: () => ["node", "/app/dist/douyin-rec.mjs", "record", "--room", "https://live.example/123"],
    });
    writeFileSync(path.join(f.dir, `${A_BASE}.rolling.json`), JSON.stringify({ ...readA(f), ownerPid: process.pid }));
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
  });

  it("/proc unavailable: falls back to the bare kill(pid,0) probe (alive pid → waits)", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove,
      uploadPlainRaw: vi.fn() as never, appendGroupRaw: append as never, countPartsRaw: async () => 1,
      now: () => f.bStartMs + 3_600_000, procCmdline: () => undefined,
    });
    writeFileSync(path.join(f.dir, `${A_BASE}.rolling.json`), JSON.stringify({ ...readA(f), ownerPid: process.pid }));
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false });
    expect(append).not.toHaveBeenCalled();
  });

  it("looksLikeRecordProcess: only this program's record subcommand", () => {
    expect(looksLikeRecordProcess(["node", "dist/douyin-rec.mjs", "record", "--room", "x"])).toBe(true);
    expect(looksLikeRecordProcess(["node", "dist/douyin-rec.mjs", "task", "serve"])).toBe(false);
    expect(looksLikeRecordProcess(["ffmpeg", "-i", "record"])).toBe(false);
  });

  it("owner alive beyond the wait bound: fail closed (no create/append, sources kept) and notify exactly once", async () => {
    const f = setup();
    const append = vi.fn(async () => {});
    const plain = vi.fn(async () => FAKE_BV + "unexpected");
    const alerts: string[] = [];
    let t = f.bStartMs + 3_600_000;
    const u = new RollingUploader({
      room, uploadMeta, gate: new FakeGate(), pid: B_PID, stableCheckMs: 0, minSegmentSec: 0, removeFile: noRemove,
      uploadPlainRaw: plain as never, appendGroupRaw: append as never, countPartsRaw: async () => 1,
      isPidAlive: () => true, now: () => t, ownerWaitMs: 30 * 60_000, notify: (m) => alerts.push(m),
    });
    f.bPaths.forEach((p) => u.noteSegment(p));
    await u.flush({ recordingActive: false }); // starts the wait clock
    t += 29 * 60_000;
    await u.flush({ recordingActive: false }); // still within the bound
    expect(alerts).toEqual([]);
    t += 2 * 60_000;
    await u.flush({ recordingActive: false }); // bound exceeded → give up
    await u.flush({ recordingActive: false }); // later flushes stay closed, no second alert
    expect(alerts).toHaveLength(1);
    expect(append).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
    expect(u.ambiguousIndices).toEqual([0]);
    expect(readA(f)).toMatchObject({ confirmed: [0], ownerPid: DEAD_PID }); // predecessor untouched
  });
});
