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

/** ffmpeg 进度/分段行的行缓冲解析器:喂 chunk,进程结束时冲刷。 */
export interface StderrParser {
  /** 喂一个 stderr chunk(内部按 \r/\n 分帧,未终结的尾部留到下个 chunk 拼接)。 */
  onChunk(chunk: string): void;
  /** 进程结束时冲刷剩余缓冲(把没等到换行符的尾行也处理掉,不丢)。 */
  flush(): void;
}

/**
 * stderr 行缓冲解析器(纯逻辑,便于单测)。
 *
 * ffmpeg 的进度行以 \r 分隔、普通日志行以 \n 结束,且 chunk 边界可能把一行拆到两个 data
 * 事件 → 先拼接缓冲再按 `\r\n`/`\r`/`\n` 切成完整行,**逐行匹配**,避免旧实现把整个
 * chunk 当一句打正则(跨 chunk 漏匹配 / 与行结构无关)。处理完再冲刷,信息不丢。
 */
export function createStderrParser(
  a: Pick<EngineSpawnArgs, "onSegment" | "markProgress" | "pushStderr">,
): StderrParser {
  let lastOutMs = 0;
  let tail = "";
  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    // 分段 muxer 每开新文件:Opening 'xxx.ts' for writing → 上报新分段。
    // 按行匹配避免跨行/跨 chunk;`(.+\.ts)` 贪婪定位到最后一段 `.ts'`,**不以撇号截断**
    // (主播名可含撇号,如 O'Brien → 旧 `[^']+` 在名字里的撇号处提前截断导致漏识别)。
    const om = /Opening '(.+\.ts)' for writing/.exec(line);
    if (om) a.onSegment(om[1]);
    // 进度 time=HH:MM:SS.xx → 输出时间戳;前进则喂看门狗(回退/重复时间戳不喂)。
    const tm = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (tm) {
      const outMs = (Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])) * 1000;
      if (outMs > lastOutMs) {
        lastOutMs = outMs;
        a.markProgress();
      }
    }
    a.pushStderr(line);
  };
  return {
    onChunk(chunk) {
      tail += chunk;
      const parts = tail.split(/\r\n|\r|\n/);
      // 最后一段可能还没等来分隔符 → 留作尾部,与下个 chunk 拼接。
      tail = parts.pop() ?? "";
      for (const p of parts) handleLine(p);
    },
    flush() {
      if (!tail) return;
      const last = tail;
      tail = "";
      handleLine(last);
    },
  };
}

export const ffmpegEngine: DownloadEngine = {
  id: "ffmpeg",
  spawn(a: EngineSpawnArgs): EngineSpawnResult {
    const { args, sessionFirstPath } = buildFfmpegArgs(a);
    const parser = createStderrParser(a);
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (c: string) => parser.onChunk(c));
    // 进程结束时冲刷行缓冲剩余(未终结的尾行也处理,不丢进度/分段)。
    proc.once("close", () => parser.flush());
    // 不分段时首段路径由 sessionFirstPath 给(单文件无 Opening 回调);分段时 stderr Opening 也会
    // 报首段 → 录制器去重(onSegment 幂等)。
    return { proc, sessionFirstPath };
  },
};
