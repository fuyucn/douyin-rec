/**
 * issue #137 返工:真实 ffmpeg/ffprobe 的转换校验回归(假探测测不出「头部完好、尾部被截断」)。
 *
 * 样本由本文件内的**生成脚本**构造(lavfi 合成 + 噪声,~2Mbps、20s、~5MB;不碰真实录像),
 * 再用 node 截断成 10% / 50% / 空 / 头部完好尾部缺失。
 * 无可用 ffmpeg 的环境(本机 libxcb 缺失、CI 无 ffmpeg)整组**跳过并明确标注**,不会让全量变红;
 * 本机 ffmpeg 坏了时,把 PATH 前置一个转发到容器的 ffmpeg/ffprobe shim 即可跑(见 PR 描述)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertSegmentInPlace, markSessionNodeFormat, NODE_REMUX_SUSPECT_SUFFIX, recoverNodeRemux, verifyRemuxed, MIN_SIZE_RATIO,
  type NodeRemuxDeps,
} from "../../packages/app/src/node-remux.js";
import { ffprobeVideo, ffprobeVideoSpan } from "../../packages/post-process/src/ffmpeg.js";

const ok = (cmd: string, args: string[]): boolean => {
  try { return spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000 }).status === 0; } catch { return false; }
};
const HAVE = ok("ffmpeg", ["-version"]) && ok("ffprobe", ["-version"])
  && ok("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5", "-t", "1", "-f", "null", "-"]);
if (!HAVE) console.warn("[node-remux-real] SKIPPED:本环境 ffmpeg/ffprobe 不可用,真实 ffmpeg 回归未执行(见 PR 描述的容器 shim 跑法)");

const B = "主播_2026-10-15_21-00-00";
const realProbe: NonNullable<NodeRemuxDeps["probe"]> = async (p) => {
  const v = await ffprobeVideo(p);
  const sp = await ffprobeVideoSpan(p);
  return { durationSec: v.durationMs / 1000, hasVideo: v.hasVideo, spanSec: sp.spanSec, packets: sp.packets };
};
const ff = (args: string[]): void => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.stderr}`);
};
/** 把 src 的前 bytes 字节写到 dst(模拟写盘中断 / ENOSPC 后的截断文件)。 */
function truncateTo(src: string, dst: string, bytes: number): void {
  const fd = openSync(src, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    writeFileSync(dst, buf.subarray(0, n));
  } finally { closeSync(fd); }
}

describe.skipIf(!HAVE)("真实 ffmpeg:转换校验识别截断/损坏", () => {
  let root: string;
  let ts: string, flv: string; // 生成的源样本
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "node-remux-real-"));
    ts = join(root, "src.ts"); flv = join(root, "src.flv");
    // 生成脚本:20s、640x360、25fps、~2Mbps 噪声源,GOP=50(2s);再无损转 flv 作 mesio 形态的源。
    ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25,noise=alls=40:allf=t", "-t", "20", "-c:v", "libx264", "-b:v", "2M", "-g", "50", "-pix_fmt", "yuv420p", "-f", "mpegts", ts]);
    ff(["-i", ts, "-c", "copy", "-f", "flv", flv]);
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** 每个用例一个干净目录,里面放一份源。 */
  const mk = (srcFile: string, name: string): { dir: string; src: string } => {
    const dir = mkdtempSync(join(root, "c-"));
    const src = join(dir, name);
    copyFileSync(srcFile, src);
    return { dir, src };
  };

  for (const fmt of ["mkv", "mp4"] as const) {
    for (const [from, srcName] of [["ts", `${B}_000.ts`], ["flv", `${B}_000.flv`]] as const) {
      it(`正常转换 ${from}→${fmt}:校验通过、只剩新文件一份、体积比 ≥ 下限`, async () => {
        const { dir, src } = mk(from === "ts" ? ts : flv, srcName);
        const alerts: string[] = [];
        const r = await convertSegmentInPlace(src, fmt, { probe: realProbe, alert: (m) => alerts.push(m) });
        expect(r).toMatchObject({ ok: true });
        expect(alerts).toEqual([]);
        expect(readdirSync(dir).filter((n) => /\.(ts|flv|mkv|mp4|drec-remux)$/.test(n))).toEqual([`${B}_000.${fmt}`]);
      }, 60_000);
    }
  }

  // 头部时长完好、尾部缺失:mkv 的 Segment 头 / faststart mp4 的 moov 在文件头,截断后 format.duration 仍是完整值。
  const SHAPES: [string, number][] = [["截到 10%", 0.1], ["截到 50%", 0.5], ["头部完好、尾部缺失(截到 80%)", 0.8], ["空文件", 0]];
  for (const fmt of ["mkv", "mp4"] as const) {
    for (const [label, frac] of SHAPES) {
      it(`${fmt} ${label}:verifyRemuxed 判失败`, async () => {
        const { dir, src } = mk(ts, `${B}_000.ts`);
        const good = join(dir, `good.${fmt}`);
        ff(["-i", src, "-c", "copy", ...(fmt === "mp4" ? ["-video_track_timescale", "90000", "-movflags", "+faststart"] : []), good]);
        const bad = join(dir, `${B}_000.${fmt}`);
        truncateTo(good, bad, Math.floor(statSync(good).size * frac));
        const reason = await verifyRemuxed(src, bad, realProbe);
        expect(reason, `${fmt} ${label} 应被识别为截断/损坏`).toBeTruthy();
        expect(await verifyRemuxed(src, good, realProbe)).toBeUndefined(); // 对照:完好文件通过
      }, 60_000);

      it(`${fmt} ${label}:崩溃接管 → 两份都保留(新文件隔离)、不删原文件、告警`, async () => {
        const { dir, src } = mk(ts, `${B}_000.ts`);
        const good = join(dir, `good.${fmt}`);
        ff(["-i", src, "-c", "copy", ...(fmt === "mp4" ? ["-video_track_timescale", "90000", "-movflags", "+faststart"] : []), good]);
        const bad = join(dir, `${B}_000.${fmt}`);
        truncateTo(good, bad, Math.floor(statSync(good).size * frac));
        rmSync(good);
        markSessionNodeFormat(dir, B, fmt);
        const origSize = statSync(src).size;
        const alerts: string[] = [];
        const r = await recoverNodeRemux(root, fmt, { probe: realProbe, alert: (m) => alerts.push(m) });
        expect(r.removedOriginal).toEqual([]);
        expect(r.keptBoth).toEqual([bad]);
        expect(existsSync(src)).toBe(true);
        expect(statSync(src).size).toBe(origSize);
        expect(existsSync(`${bad}${NODE_REMUX_SUSPECT_SUFFIX}`)).toBe(true);
        expect(alerts).toHaveLength(1);
      }, 60_000);

      it(`${fmt} ${label}:正常转换路径(remux 产出被截断)→ 校验失败、原文件保留、无临时文件残留`, async () => {
        const { dir, src } = mk(ts, `${B}_000.ts`);
        const alerts: string[] = [];
        const r = await convertSegmentInPlace(src, fmt, {
          probe: realProbe,
          alert: (m) => alerts.push(m),
          // 真 remux 后把临时文件截断,模拟写盘中断
          remux: async (s, tmp, f) => {
            const { remuxSegment } = await import("../../packages/post-process/src/index.js");
            await remuxSegment(s, tmp, f);
            truncateTo(tmp, tmp, Math.floor(statSync(tmp).size * frac));
          },
        });
        expect(r).toMatchObject({ ok: false, reason: "verify-failed" });
        expect(existsSync(src)).toBe(true);
        expect(readdirSync(dir).filter((n) => n.endsWith(".drec-remux") || n.endsWith(`.${fmt}`))).toEqual([]);
        expect(alerts).toHaveLength(1);
      }, 60_000);
    }
  }

  it("接管:新文件完好的配对 → 才删原文件", async () => {
    const { dir, src } = mk(ts, `${B}_000.ts`);
    ff(["-i", src, "-c", "copy", join(dir, `${B}_000.mkv`)]);
    markSessionNodeFormat(dir, B, "mkv");
    const r = await recoverNodeRemux(root, "mkv", { probe: realProbe });
    expect(r.removedOriginal).toEqual([src]);
    expect(existsSync(join(dir, `${B}_000.mkv`))).toBe(true);
  }, 60_000);

  it("MIN_SIZE_RATIO 与实测一致:完好 ts→mkv/mp4、flv→mp4 体积比都高于下限", () => {
    for (const [from, to] of [["ts", "mkv"], ["ts", "mp4"], ["flv", "mp4"]] as const) {
      const { dir, src } = mk(from === "ts" ? ts : flv, `${B}_000.${from}`);
      const out = join(dir, `o.${to}`);
      ff(["-i", src, "-c", "copy", out]);
      const ratio = statSync(out).size / statSync(src).size;
      console.log(`[node-remux-real] ${from}→${to} 体积比 ${ratio.toFixed(3)}`);
      expect(ratio).toBeGreaterThan(MIN_SIZE_RATIO);
    }
  }, 60_000);
});
