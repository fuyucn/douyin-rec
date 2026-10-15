/**
 * issue #140:产物落盘原子化(`.part` → rename)。
 *
 * 用 PATH 上的**假 ffmpeg** 验证真落盘行为(不依赖系统 ffmpeg,也不需要真编码):
 *  · 成功 → 最终名出现、临时名消失;
 *  · 失败/被杀 → **最终名绝不出现**(这是 incident 的根:半成品以最终名存在就会被当成品复用/投稿)。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicPartPath, burn, isCompleteMedia, mergeSession, remuxSegment, runFfmpegAtomic, unreadableParts, withAtomicOutput,
} from "@drec/post-process";

describe("产物原子落盘(issue #140)", () => {
  let binDir = "";
  let oldPath = "";
  const newDir = (): string => mkdtempSync(join(tmpdir(), "atomic-"));

  beforeAll(() => {
    binDir = newDir();
    // 假 ffmpeg:把 "OK" 写到**最后一个参数**(= 输出路径);FAKE_FFMPEG_FAIL=1 时先写一半再非零退出。
    const script = join(binDir, "ffmpeg");
    writeFileSync(script, [
      "#!/bin/sh",
      "out=\"\"",
      "for a in \"$@\"; do out=\"$a\"; done",
      "fail=${FAKE_FFMPEG_FAIL:-0}",
      "if [ -n \"${FAKE_FFMPEG_FAIL_ON:-}\" ]; then case \"$out\" in *\"$FAKE_FFMPEG_FAIL_ON\"*) fail=1 ;; esac; fi",
      "printf 'OK' > \"$out\"",
      "if [ \"$fail\" = \"1\" ]; then printf 'HALF' >> \"$out\"; exit 1; fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(script, 0o755);
    oldPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${oldPath}`;
  });

  afterAll(() => { process.env.PATH = oldPath; });
  afterEach(() => { delete process.env.FAKE_FFMPEG_FAIL; delete process.env.FAKE_FFMPEG_FAIL_ON; });

  it("临时名:同目录、保留扩展名、`.` 前缀", () => {
    expect(atomicPartPath("/s/主播_000.mp4")).toBe("/s/.主播_000.part.mp4");
    expect(atomicPartPath("/s/主播_000.mkv")).toBe("/s/.主播_000.part.mkv");
  });

  it("withAtomicOutput 只换最后一个参数(输出路径),其余逐字不动", () => {
    expect(withAtomicOutput(["-y", "-i", "/in.ts", "-c", "copy", "/out/000.mp4"], "/out/000.mp4"))
      .toEqual(["-y", "-i", "/in.ts", "-c", "copy", "/out/.000.part.mp4"]);
  });

  it("rc=0 → 最终名出现、临时名消失", async () => {
    const dir = newDir();
    const out = join(dir, "a.mp4");
    await runFfmpegAtomic(["-y", "-i", join(dir, "in.ts"), out], out);
    expect(readFileSync(out, "utf-8")).toBe("OK");
    expect(readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
  });

  it("ffmpeg 失败 → **最终名不出现**(半成品只留在 .part,不会被当成品复用)", async () => {
    const dir = newDir();
    const out = join(dir, "a.mp4");
    process.env.FAKE_FFMPEG_FAIL = "1";
    await expect(runFfmpegAtomic(["-y", "-i", join(dir, "in.ts"), out], out)).rejects.toThrow(/rc=1/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(atomicPartPath(out))).toBe(true); // 半成品在临时名上,下一次 -y 覆盖
  });

  it("remuxSegment 走同一条原子路径(成功有最终名 / 失败没有)", async () => {
    const dir = newDir();
    const src = join(dir, "src.ts");
    writeFileSync(src, "SRC");
    const out = join(dir, "b.mp4");
    await remuxSegment(src, out);
    expect(readFileSync(out, "utf-8")).toBe("OK");

    const out2 = join(dir, "c.mp4");
    process.env.FAKE_FFMPEG_FAIL = "1";
    await expect(remuxSegment(src, out2)).rejects.toThrow(/rc=1/);
    expect(existsSync(out2)).toBe(false);
  });

  it("mergeSession 也走原子收尾:规范化成功但 concat 失败 → 最终名不出现", async () => {
    const dir = newDir();
    const s1 = join(dir, "s1.ts");
    writeFileSync(s1, "S1");
    const ok = join(dir, "merged.mp4");
    await mergeSession([s1], ok);
    expect(readFileSync(ok, "utf-8")).toBe("OK");

    // 只让 concat 那一步失败(规范化写的是 segNNN.ts,不匹配)→ 证明最终产物没落地。
    process.env.FAKE_FFMPEG_FAIL_ON = "merged2";
    const bad = join(dir, "merged2.mp4");
    await expect(mergeSession([s1], bad)).rejects.toThrow(/rc=1/);
    expect(existsSync(bad)).toBe(false);
  });

  it("burn 也走原子收尾(失败不留最终名)", async () => {
    const dir = newDir();
    const video = join(dir, "v.mp4");
    writeFileSync(video, "V");
    const ok = join(dir, "v_danmu.mp4");
    await burn({ inputMp4: video, assText: "[Script Info]\n", outMp4: ok, fontsDir: dir });
    expect(readFileSync(ok, "utf-8")).toBe("OK");

    process.env.FAKE_FFMPEG_FAIL_ON = "v2_danmu";
    const bad = join(dir, "v2_danmu.mp4");
    await expect(burn({ inputMp4: video, assText: "[Script Info]\n", outMp4: bad, fontsDir: dir })).rejects.toThrow(/rc=1/);
    expect(existsSync(bad)).toBe(false);
  });

  it("相对输出路径也走同一套临时名/rename(burn 以输出目录为 cwd)", async () => {
    const dir = newDir();
    const video = join(dir, "v3.mp4");
    writeFileSync(video, "V");
    const rel = join(dir, "rel_danmu.mp4");
    await burn({ inputMp4: video, assText: "[Script Info]\n", outMp4: rel, fontsDir: dir });
    expect(readFileSync(rel, "utf-8")).toBe("OK");
    expect(existsSync(atomicPartPath(rel))).toBe(false);
  });
});

describe("产物可读性自检(issue #140)", () => {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  const good = join(dir, "good.mp4");
  const bad = join(dir, "bad.mp4");
  writeFileSync(good, "x");
  writeFileSync(bad, "x");

  it("unreadableParts:只收「探测 ≤0 / 抛错」的文件", async () => {
    const probe = async (f: string): Promise<number> => {
      if (f === bad) return 0;
      if (f.endsWith("boom.mp4")) throw new Error("ffprobe 挂了");
      return 60;
    };
    expect(await unreadableParts([good, bad, join(dir, "boom.mp4")], probe)).toEqual([bad, join(dir, "boom.mp4")]);
    expect(await unreadableParts([good], probe)).toEqual([]);
    expect(await unreadableParts([], probe)).toEqual([]);
  });

  it("isCompleteMedia:不存在 / 读不出 → false;可读 → true", async () => {
    const probe = async (f: string): Promise<number> => (f === bad ? 0 : 60);
    expect(await isCompleteMedia(good, probe)).toBe(true);
    expect(await isCompleteMedia(bad, probe)).toBe(false);
    expect(await isCompleteMedia(join(dir, "nope.mp4"), probe)).toBe(false);
  });
});
