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
import { copyFileSync, existsSync, mkdtempSync, openSync, closeSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertSegmentInPlace, markSessionNodeFormat, NODE_REMUX_SUSPECT_SUFFIX, packetAllowance, recoverNodeRemux, recoverNodeRemuxInBackground, verifyRemuxed, MIN_SIZE_RATIO,
  type NodeRemuxDeps,
} from "../../packages/app/src/node-remux.js";
import { ffprobePacketStats, ffprobeVideo } from "../../packages/post-process/src/ffmpeg.js";
import { mergeSession } from "../../packages/post-process/src/concat.js";

const ok = (cmd: string, args: string[]): boolean => {
  try { return spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000 }).status === 0; } catch { return false; }
};
const HAVE = ok("ffmpeg", ["-version"]) && ok("ffprobe", ["-version"])
  && ok("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5", "-t", "1", "-f", "null", "-"]);
if (!HAVE) console.warn("[node-remux-real] SKIPPED:本环境 ffmpeg/ffprobe 不可用,真实 ffmpeg 回归未执行(见 PR 描述的容器 shim 跑法)");

const B = "主播_2026-10-15_21-00-00";
const realProbe: NonNullable<NodeRemuxDeps["probe"]> = async (p) => {
  const v = await ffprobeVideo(p);
  const st = await ffprobePacketStats(p);
  if (!st) throw new Error("全包扫描无法判定");
  return {
    durationSec: v.durationMs / 1000, hasVideo: v.hasVideo, spanSec: st.spanSec, packets: st.videoPackets,
    gopPackets: st.gopPackets, hasAudio: st.hasAudio, audioPackets: st.audioPackets, scanErrors: st.errorLines,
  };
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
    // 带音频(aac 48k):包数 / 音频校验需要有音轨的源。
    ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25,noise=alls=40:allf=t", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "20", "-c:v", "libx264", "-b:v", "2M", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-f", "mpegts", ts]);
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

// ───────────── 返工第 2 轮:包数 / 音频 / 补零 mp4 不挂死 ─────────────
describe.skipIf(!HAVE)("真实 ffmpeg:包数、音频、补零文件(返工第 2 轮)", () => {
  let root: string;
  let ts: string, flv: string, long: string;
  const zeroRange = (src: string, dst: string, from: number, to: number): void => {
    const b = Buffer.from(readFileSync(src));
    b.fill(0, Math.floor(b.length * from), Math.floor(b.length * to));
    writeFileSync(dst, b);
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "node-remux-real2-"));
    ts = join(root, "src.ts"); flv = join(root, "src.flv"); long = join(root, "long.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25,noise=alls=40:allf=t", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "20", "-c:v", "libx264", "-b:v", "2M", "-g", "50", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest", "-f", "mpegts", ts]);
    ff(["-i", ts, "-c", "copy", "-f", "flv", flv]);
    // 长样本(300s、低码率):补零后 ffprobe 对每个坏包报一行 stderr,总量远超 64KB 管道缓冲 —— 旧实现在此挂死。
    const tmpLong = join(root, "long.ts");
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30,noise=alls=30:allf=t", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", "300", "-c:v", "libx264", "-b:v", "300k", "-g", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-shortest", "-f", "mpegts", tmpLong]);
    ff(["-i", tmpLong, "-c", "copy", "-video_track_timescale", "90000", "-movflags", "+faststart", long]);
  }, 300_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const sample = (from: "ts" | "flv"): { dir: string; src: string } => {
    const dir = mkdtempSync(join(root, "c-"));
    const src = join(dir, `${B}_000.${from}`);
    copyFileSync(from === "ts" ? ts : flv, src);
    return { dir, src };
  };

  for (const [from, to] of [["ts", "mkv"], ["ts", "mp4"], ["flv", "mp4"]] as const) {
    it(`正常转换 ${from}→${to} 不被误拒;包数对比(视频/音频)`, async () => {
      const { dir, src } = sample(from);
      const out = join(dir, `o.${to}`);
      ff(["-i", src, "-c", "copy", ...(to === "mp4" ? ["-video_track_timescale", "90000", "-movflags", "+faststart"] : []), out]);
      const a = await realProbe(src), b = await realProbe(out);
      console.log(`[node-remux-real] ${from}→${to} 视频包 ${a.packets}→${b.packets} 音频包 ${a.audioPackets}→${b.audioPackets} GOP=${a.gopPackets} scanErrors ${a.scanErrors}→${b.scanErrors}`);
      expect(await verifyRemuxed(src, out, realProbe)).toBeUndefined();
      expect(b.hasAudio).toBe(true);
    }, 60_000);
  }

  // 中段「抹掉」但时间戳跨度保留:把 [0,7s) 与 [13s,20s) 两段原样拼起来(PTS 留空洞)——
  // 头部时长 / 跨度 / 体积都正常(≥0.5),只有包数少了约三成。这是包数检查独有的覆盖。
  it("中段丢失约 30%(跨度/头部时长/体积都正常):被包数检查拒", async () => {
    const { dir, src } = sample("ts");
    ff(["-ss", "0", "-t", "7", "-i", src, "-c", "copy", "-copyts", join(dir, "a.ts")]);
    ff(["-ss", "13", "-i", src, "-c", "copy", "-copyts", join(dir, "b.ts")]);
    writeFileSync(join(dir, "gap.ts"), Buffer.concat([readFileSync(join(dir, "a.ts")), readFileSync(join(dir, "b.ts"))]));
    const out = join(dir, "gap.mkv");
    ff(["-i", join(dir, "gap.ts"), "-c", "copy", "-copyts", out]);
    const a = await realProbe(src), b = await realProbe(out);
    console.log(`[node-remux-real] 中段丢失:视频包 ${a.packets}→${b.packets} 音频包 ${a.audioPackets}→${b.audioPackets} 跨度 ${a.spanSec.toFixed(1)}→${b.spanSec.toFixed(1)}s 体积比 ${(statSync(out).size / statSync(src).size).toFixed(2)}`);
    expect(Math.abs(b.spanSec - a.spanSec)).toBeLessThan(3); // 跨度巧合正常
    // 头部时长:拼接产物的 mkv 头里时长含起点偏移(22.9s),与本用例要隔离的包数检查无关;
    // 这里按「头部时长完好」(mkv 头时长本来就能被任意写成完整值)取原文件时长,其余(跨度/包数/体积)全是真实扫描值。
    const headerOk: typeof realProbe = async (p) => (p === out ? { ...(await realProbe(p)), durationSec: a.durationSec } : realProbe(p));
    const reason = await verifyRemuxed(src, out, headerOk);
    expect(reason).toMatch(/视频包数不足/);
  }, 60_000);

  for (const fmt of ["mkv", "mp4"] as const) {
    it(`去掉整条音轨(${fmt}):视频跨度/包数/体积都正常,被音频检查拒`, async () => {
      const { dir, src } = sample("ts");
      const out = join(dir, `na.${fmt}`);
      ff(["-i", src, "-map", "0:v", "-c", "copy", "-an", out]);
      const a = await realProbe(src), b = await realProbe(out);
      console.log(`[node-remux-real] 去音轨 ${fmt}:视频包 ${a.packets}→${b.packets} 音频包 ${a.audioPackets}→${b.audioPackets}`);
      expect(await verifyRemuxed(src, out, realProbe)).toMatch(/缺少音频流/);
    }, 60_000);
  }

  it("补零的 mp4(索引完好、数据被补零,stderr 洪水):校验在时限内返回失败,不挂死;接管后台执行、不阻塞", async () => {
    const dir = mkdtempSync(join(root, "z-"));
    const src = join(dir, `${B}_000.ts`);
    // 源 = 长样本的 ts 形态
    ff(["-i", long, "-c", "copy", "-f", "mpegts", src]);
    const bad = join(dir, `${B}_000.mp4`);
    zeroRange(long, bad, 0.1, 1.0);
    markSessionNodeFormat(dir, B, "mp4");
    const t0 = Date.now();
    const reason = await verifyRemuxed(src, bad, realProbe);
    const secs = (Date.now() - t0) / 1000;
    console.log(`[node-remux-real] 补零 mp4 校验耗时 ${secs.toFixed(1)}s,结果: ${reason}`);
    expect(secs).toBeLessThan(120);
    expect(reason).toBeTruthy();
    // 接管走后台:调用立刻返回 Promise,开录路径不等
    const alerts: string[] = [];
    const t1 = Date.now();
    const p = recoverNodeRemuxInBackground(root, "mp4", { probe: realProbe, alert: (m) => alerts.push(m) });
    expect(Date.now() - t1).toBeLessThan(500);
    const r = await p;
    expect(r?.removedOriginal).toEqual([]);
    expect(existsSync(src)).toBe(true);
    expect(r?.keptBoth).toContain(bad);
  }, 240_000);

  it("混合容器(同会话 mkv + ts + mp4 分段):mergeSession 规范化后拼接,总包数 = 各段之和", async () => {
    const dir = mkdtempSync(join(root, "m-"));
    const a = join(dir, `${B}_000.mkv`), b = join(dir, `${B}_001.ts`), c = join(dir, `${B}_002.mp4`);
    ff(["-i", ts, "-c", "copy", a]);
    copyFileSync(ts, b);
    ff(["-i", ts, "-c", "copy", c]);
    const out = join(dir, "merged.mkv");
    await mergeSession([a, b, c], out);
    const one = await realProbe(ts), all = await realProbe(out);
    console.log(`[node-remux-real] 混合合并:单段视频包 ${one.packets},合并后 ${all.packets}(期望≈${one.packets * 3}),跨度 ${all.spanSec.toFixed(1)}s`);
    expect(Math.abs(all.packets - one.packets * 3)).toBeLessThanOrEqual(3 * packetAllowance(one.packets, one.gopPackets));
    expect(all.hasAudio).toBe(true);
  }, 120_000);
});
