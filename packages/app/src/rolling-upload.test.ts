import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("RollingUploader — 边录边传录制端执行", () => {
  it("只处理封口段:有后继段的旧段上传+删,正在写的最近段不动", async () => {
    const { paths } = mkSession(segNames(3));
    const up = vi.fn(async () => "BV1aaaaaaaaa");
    const remove = vi.fn(noRemove);
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: remove, now: futureNow });
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

  it("单段 + 已收尾 → 最后一个封口段也上传;重启读 sidecar 不重复建稿", async () => {
    const { paths } = mkSession(segNames(1));
    const up = vi.fn(async () => "BV1bbbbbbbbb");
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, sealGraceMs: 0 });
    u1.noteSegment(paths[0]);
    const r1 = await u1.flush({ recordingActive: false });
    expect(r1.uploaded).toEqual([0]);
    expect(up).toHaveBeenCalledTimes(1);

    // 新实例 = 进程重启:sidecar 已记录确认,绝不再建稿。
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: noopAppend, removeFile: noRemove, now: futureNow, sealGraceMs: 0 });
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
    const u = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: remove, now: futureNow, sealGraceMs: 0 });
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
    const u1 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, sealGraceMs: 0 });
    u1.noteSegment(paths[0]);
    await u1.flush({ recordingActive: false });
    expect(u1.confirmedIndices).toEqual([0]);

    // 重启(新实例,读 sidecar):新段 s_001 必须分到段号 1 并 append(而不是复用 0 被跳过)。
    const u2 = new RollingUploader({ room, uploadMeta, gate: new FakeGate(), uploadPlainRaw: up, appendGroupRaw: ap, removeFile: noRemove, now: futureNow, sealGraceMs: 0 });
    u2.noteSegment(paths[1]);
    const r2 = await u2.flush({ recordingActive: false });
    expect(r2.uploaded).toEqual([1]);
    expect(ap).toHaveBeenCalledTimes(1);
    expect(up).toHaveBeenCalledTimes(1); // 建稿仍只发生过一次
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
