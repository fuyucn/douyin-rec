// Barrel:vendored 抖音提取(从 @bililive-tools/douyin-recorder@1.17.0 lib 复制,含 FLV 重连 patch)。
// 我们自有副本 → 不再依赖该 npm 包,可自行扩展(如 H265/HEVC)。算法核心 sign.js(a_bogus)逐字节保留。
export { getStream, getInfo } from "./stream.js";
export { resolveShortURL } from "./douyin_api.js";
