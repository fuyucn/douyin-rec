// @drec/post-process — 后处理(纯函数):多会话拼接 / 弹幕 ASS 渲染 / ffmpeg 烧录 / 字体。
export { groupSessions, mergeSession } from "./concat.js";
export { burn } from "./burn.js";
export { FONTS_DIR } from "./fonts.js";
export { renderXmlToAss, renderXmlToLivechat } from "./ass/render.js";
export { renderSegmentsToAss } from "./ass/multi.js";
export { mergeXmlContents, type MergeXmlSession } from "./merge-xml.js";
export { mergeSessions, type MergeSessionInput } from "./merge.js";
export { runFfmpeg, ffprobeDuration, ffprobeVideo } from "./ffmpeg.js";
export { splitToSizeLimit, planSizeSplit, buildSplitArgs, BILI_FILE_LIMIT_BYTES } from "./split.js";
