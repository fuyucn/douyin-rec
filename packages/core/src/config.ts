import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";

export interface AppConfig {
  /** 画质档:**平台自解释的字符串**(抖音 origin/uhd/hd/sd/ld,见 @drec/douyin-live)。通用层不写死。 */
  quality: string;
  /**
   * 下载引擎 id(ffmpeg / mesio)。字段名沿用旧名 `recorder` 以兼容历史 YAML;cli `record`
   * 当作 `--engine` 回落值读取(非法/旧 provider 名 → getEngine 返 undefined → 回落平台默认引擎)。
   */
  recorder: string;
  /** 弹幕开关字符串(1/0/on/off/none);来源由命中平台的 connectDanmu 决定,不再是 provider 名。 */
  danmu: string;
  cookies?: string;
  /** 输出目录。留空(默认)= 由使用处解析(cli record 回落 `@drec/app` 的 `rootOutputDir()`,
   *  即 `<DOUYIN_REC_ROOT ?? DEFAULT_ROOT>/recordings`)——core 不依赖 app,故不在此写死路径。 */
  outDir: string;
  segmentSec: number;
  /** 弹幕 xml 粒度: "session"(整场一个,默认,稳) | "segment"(逐段一个)。 */
  danmuXmlMode: "session" | "segment";
  pollIntervalSec: number;
  /** Seconds to wait before restarting recorder after an unexpected stream drop (default 5). */
  reconnectDelaySec: number;
  /** Discord incoming webhook URL for notifications. Omit to disable. */
  discordWebhook?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  quality: "origin",
  // recorder(=引擎回落值)/danmu 留空(去平台硬编码):未在 YAML/命令行指定时,由使用处按
  // Platform.defaultEngine 解析(见 cli record / store.addTask)。接第二平台时各平台默认各异,不写死抖音。
  recorder: "",
  danmu: "",
  outDir: "", // 留空同 recorder/danmu:回落值由使用处解析(见上方字段注释),不写死路径。
  segmentSec: 1800,
  danmuXmlMode: "session",
  pollIntervalSec: 30,
  reconnectDelaySec: 5,
};

export function loadConfig(path?: string): AppConfig {
  if (!path || !existsSync(path)) return { ...DEFAULT_CONFIG };
  const raw = parse(readFileSync(path, "utf-8")) ?? {};
  return { ...DEFAULT_CONFIG, ...raw };
}
