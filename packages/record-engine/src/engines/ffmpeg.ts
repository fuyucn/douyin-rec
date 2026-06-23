/**
 * ffmpeg 下载引擎 — `ffmpeg -c copy -map 0` 落盘 .ts(+ 分段)。
 *
 * 提炼自原 douyin-live-recorder / bilibili-live-recorder(两者除来路 header 外完全一致;header
 * 现经 EngineSpawnArgs.headers 透传 → `-user_agent`/`-referer`/`-headers`,故合并为一个引擎)。
 *
 * 进度上报:解析 stderr `Opening '…ts' for writing`→onSegment、`time=HH:MM:SS.xx`→markProgress。
 * HTTP(S) 流开启 ffmpeg 自动重连(短暂抖动不必整段重起)。产物 .ts(分段 {nameBase}_%03d.ts,
 * 不分段 {nameBase}.ts)。
 */
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DownloadEngine, EngineSpawnArgs, EngineSpawnResult } from "@drec/core";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** 来路 header → ffmpeg flag:User-Agent/Referer 用专属 flag,其余进 -headers。 */
function headerArgs(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.entries(headers).flatMap(([k, v]) =>
    /^user-agent$/i.test(k) ? ["-user_agent", v] : /^referer$/i.test(k) ? ["-referer", v] : ["-headers", `${k}: ${v}\r\n`],
  );
}

/** 构造 ffmpeg argv(纯函数,便于单测)。 */
export function buildFfmpegArgs(a: Pick<EngineSpawnArgs, "url" | "headers" | "dir" | "nameBase" | "segSec">): { args: string[]; sessionFirstPath: string } {
  const base = join(a.dir, a.nameBase);
  const isHttp = /^https?:/.test(a.url);
  const hdrs = isHttp ? headerArgs(a.headers) : [];
  // HTTP(S) FLV/HLS 流:开启 ffmpeg 自动重连(短暂抖动不必整段重起)。
  const reconnect = isHttp
    ? ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30"]
    : [];
  const outArgs = a.segSec > 0
    ? ["-f", "segment", "-segment_time", String(a.segSec), "-reset_timestamps", "1", "-segment_format", "mpegts", `${base}_%03d.ts`]
    : [`${base}.ts`];
  const args = ["-y", ...hdrs, ...reconnect, "-i", a.url, "-c", "copy", "-map", "0", ...outArgs];
  // 不分段:首段即 {base}.ts;分段:首段 {base}_000.ts(stderr Opening 也会上报,这里给 session 的 base)。
  const sessionFirstPath = a.segSec > 0 ? `${base}_000.ts` : `${base}.ts`;
  return { args, sessionFirstPath };
}

export const ffmpegEngine: DownloadEngine = {
  id: "ffmpeg",
  spawn(a: EngineSpawnArgs): EngineSpawnResult {
    const { args, sessionFirstPath } = buildFfmpegArgs(a);
    let lastOutMs = 0;
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (c: string) => {
      // 分段 muxer 每开新文件:Opening 'xxx.ts' for writing → 上报新分段。
      const re = /Opening '([^']+\.ts)' for writing/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(c))) a.onSegment(m[1]);
      // 进度 time=HH:MM:SS.xx → 输出时间戳;前进则喂看门狗。
      const tre = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
      let tm: RegExpExecArray | null;
      let outMs = -1;
      while ((tm = tre.exec(c))) outMs = (Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])) * 1000;
      if (outMs > lastOutMs) { lastOutMs = outMs; a.markProgress(); }
      for (const line of c.split(/\r?\n/)) {
        const t = line.trim();
        if (t) a.pushStderr(t);
      }
    });
    // 不分段时首段路径由 sessionFirstPath 给(单文件无 Opening 回调);分段时 stderr Opening 也会
    // 报首段 → 录制器去重(onSegment 幂等)。
    return { proc, sessionFirstPath };
  },
};
