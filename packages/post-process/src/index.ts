// @drec/post-process — 后处理(纯函数):多会话拼接 / 弹幕 ASS 渲染 / ffmpeg 烧录 / 字体。
export { groupSessions, mergeSession, readNodeFormats, type GroupSessionsOpts } from "./concat.js";
export { burn } from "./burn.js";
export { FONTS_DIR } from "./fonts.js";
export { renderXmlToAss, renderXmlToLivechat } from "./ass/render.js";
export { renderSegmentsToAss } from "./ass/multi.js";
export { remuxSegment, buildRemuxArgs, renderXmlWindowToAss, planSegmentGroups, type SegmentStyle } from "./segment.js";
export { atomicPartPath, withAtomicOutput, runFfmpegAtomic, unreadableParts, isCompleteMedia } from "./artifact.js";
export {
  mergeXmlContents,
  renderXmlWindowToXml,
  type MergeXmlSession,
  type XmlWindowRenderResult,
} from "./merge-xml.js";
export { mergeSessions, type MergeSessionInput } from "./merge.js";
export type { PacketStats } from "./ffmpeg.js";
export { runFfmpeg, ffprobeDuration, ffprobeVideo, ffprobeVideoSpan, ffprobePacketStats, runFfprobe, FFPROBE_SCAN_TIMEOUT_MS, FFPROBE_HEADER_TIMEOUT_MS } from "./ffmpeg.js";
export {
  scanMediaErrors,
  parseFfmpegErrors,
  parseFfmpegIssues,
  classifyFfmpegLine,
  formatScanLine,
  formatOutputVerdict,
  parseIntegrityWarnings,
  parseIntegrityAlerts,
  TAIL_ALERT_MIN_PROBLEMS,
  type MediaScanResult,
  type ParsedIssues,
} from "./integrity.js";
export { splitToSizeLimit, planSizeSplit, buildSplitArgs, BILI_FILE_LIMIT_BYTES } from "./split.js";
