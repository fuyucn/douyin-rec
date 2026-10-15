/**
 * 输出格式(issue #137):任务级 `outputFormat` 的白名单 / 注册表 / 生效判定(唯一真理源)。
 *
 * 语义:**只换容器、不并存两份**。`original` = 沿用现状(后处理产物仍是 mp4,录制分段仍是引擎原生容器)。
 * 加新格式 = `STAGE_CONTAINERS` 加一行 + `OUTPUT_FORMATS` 加值;其余消费点(扩展名/ffmpeg 封装参数/
 * 下游扩展名识别/web 下拉)都从这里派生,禁止在别处再写死 `.mp4` / `+faststart`。
 */
import type { UploadMode } from "./api-types.js";

/** 白名单(含 `original`)。非白名单值一律被 `parseOutputFormat` 拒绝。 */
export const OUTPUT_FORMATS = ["original", "mp4", "mkv"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "original";

/** 后处理产物能落的容器(= 白名单去掉 `original`)。 */
export type StageFormat = Exclude<OutputFormat, "original">;

/** 一个后处理容器的登记项。 */
export interface StageContainer {
  /** 含点的扩展名。 */
  ext: string;
  /**
   * ffmpeg `-f` 封装器名。输出路径带非常规扩展名(节点侧原地替换的临时文件 `*.drec-remux`)时
   * 不能靠扩展名推断容器,必须显式指定。
   */
  muxer: string;
  /**
   * 单段 `-c copy` remux 的**输出侧**专属参数。mp4:FLV(1000Hz)直拷会得到非标准 time_base,
   * 钉成 90000(B 站转码器拒收非标时基);另加 faststart。这两个是 mp4 专属参数,
   * mkv 不需要也不带它们 → mkv 为空。
   */
  remuxArgs: string[];
  /** concat / 烧录(重编码)产物的输出侧专属参数。mp4:faststart;mkv:无。 */
  finalizeArgs: string[];
}

export const STAGE_CONTAINERS: Record<StageFormat, StageContainer> = {
  mp4: {
    ext: ".mp4",
    muxer: "mp4",
    remuxArgs: ["-video_track_timescale", "90000", "-movflags", "+faststart"],
    finalizeArgs: ["-movflags", "+faststart"],
  },
  mkv: { ext: ".mkv", muxer: "matroska", remuxArgs: [], finalizeArgs: [] },
};

export function isOutputFormat(v: unknown): v is OutputFormat {
  return typeof v === "string" && (OUTPUT_FORMATS as readonly string[]).includes(v);
}

/** 校验:缺省/`undefined`/`null` → `original`;白名单外(含空串、大小写不符)→ 抛错。 */
export function parseOutputFormat(v: unknown): OutputFormat {
  if (v === undefined || v === null) return DEFAULT_OUTPUT_FORMAT;
  if (isOutputFormat(v)) return v;
  throw new Error(`outputFormat 只能是 ${OUTPUT_FORMATS.join(" / ")},收到 ${JSON.stringify(v)}`);
}

/** 宽松读取(读库/读旧配置用):非法值回落 `original`,不抛。写入口必须走 `parseOutputFormat`。 */
export function readOutputFormat(v: unknown): OutputFormat {
  return isOutputFormat(v) ? v : DEFAULT_OUTPUT_FORMAT;
}

/**
 * 后处理产物(合并片 / 分段分 P / 烧录产物)的**生效容器**。
 * - `original` → mp4(现状);
 * - 投稿(`upload` / `rolling`,含节点侧上传)一律强制 mp4(平台要求,选项被锁);
 * - 否则(存档 `stage`)按所选。
 */
export function effectiveStageFormat(
  outputFormat: OutputFormat | undefined,
  uploadMode: UploadMode | undefined,
): StageFormat {
  if (uploadMode === "upload" || uploadMode === "rolling") return "mp4";
  const f = outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  return f === "original" ? "mp4" : f;
}

/** 该投稿模式下 `outputFormat` 选项是否被锁定为 mp4(web 规则模块与后端判定共用)。 */
export function outputFormatLocked(uploadMode: UploadMode | undefined): boolean {
  return uploadMode === "upload" || uploadMode === "rolling";
}

/** 后处理产物扩展名(含点)。 */
export function stageExt(fmt: StageFormat): string {
  return STAGE_CONTAINERS[fmt].ext;
}

/** 按**路径扩展名**反查后处理容器登记项(burn/split 等只拿到路径的场合);未登记扩展名回落 mp4。 */
export function stageContainerOfPath(p: string): StageContainer {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  return Object.values(STAGE_CONTAINERS).find((c) => c.ext === ext) ?? STAGE_CONTAINERS.mp4;
}

/** 后处理产物扩展名全集(含点,小写),供下游识别。 */
export const STAGE_EXTS: readonly string[] = Object.values(STAGE_CONTAINERS).map((c) => c.ext);

/**
 * 视频文件扩展名(含点,小写)全集:录制原生(ts/flv)+ 后处理容器(mp4/mkv)。
 * 下游「认视频」的地方(清单扫描 / 会话分组 / 清理)统一用它,别再写死 ts|flv|mp4。
 */
export const VIDEO_EXTS: readonly string[] = [".ts", ".flv", ...STAGE_EXTS];

/** 是否视频容器文件(按扩展名;`.xml/.ass` 恒 false)。 */
export function isVideoFileName(name: string): boolean {
  const i = name.lastIndexOf(".");
  return i >= 0 && VIDEO_EXTS.includes(name.slice(i).toLowerCase());
}

/** 去掉末尾的视频容器扩展名(非视频扩展名原样返回)。 */
export function stripVideoExt(name: string): string {
  return isVideoFileName(name) ? name.slice(0, name.lastIndexOf(".")) : name;
}

/** 供拼正则用:`ts|flv|mp4|mkv`(无点)。 */
export const VIDEO_EXT_ALT = VIDEO_EXTS.map((e) => e.slice(1)).join("|");
/** 供拼正则用:后处理容器 `mp4|mkv`(无点)。 */
export const STAGE_EXT_ALT = STAGE_EXTS.map((e) => e.slice(1)).join("|");
