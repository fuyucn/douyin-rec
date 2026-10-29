/**
 * 会话基名 / 段号(唯一真理源)。
 *
 * 录制产物的分段后缀有三种写法:`-PART01`(biliLive)、`_PART001`(biliLive 下划线)、
 * `_000`(本项目录制器/DLR/mesio 的裸段号,须 3 位以上,避免把基名尾部短数字误当段号)。
 * 同一会话的所有分段(及其 .xml)共享同一个「会话基名」。
 *
 * 两种语义,调用点按需选:
 * - `sessionBaseOf`:**宽松**。只剥扩展名 + 分段后缀,不要求名字带时间戳(总有返回值)。
 *   用于「已知是录制产物」的场景(合并分组、孤儿清理、弹幕 xml 路径)。
 * - `stampedSessionBaseOf`:**锚定**。要求 `{主播}_{YYYY-MM-DD}_{HH-MM-SS}` 时间戳基名,
 *   不符返回 undefined。用于「从目录里挑出录制会话文件」的场景(过滤掉无关文件)。
 *
 * 仓库内禁止再写第二份同类正则(test/arch/session-name-guard.test.ts 守护)。
 */

import { VIDEO_EXT_ALT } from "./output-format.js";

const SEGMENT_SUFFIX_SRC = String.raw`(?:-PART\d+|_PART\d+|_\d{3,})`;
const SEGMENT_SUFFIX_END = new RegExp(`${SEGMENT_SUFFIX_SRC}$`, "i");
const SEGMENT_INDEX = new RegExp(`(?:-PART(\\d+)|_PART(\\d+)|_(\\d{3,}))\\.(?:${VIDEO_EXT_ALT}|xml)$`, "i");
const STAMPED = new RegExp(
  `^(.+_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})${SEGMENT_SUFFIX_SRC}?\\.(?:${VIDEO_EXT_ALT}|xml)$`,
  "i",
);
/** 宽松口径认的容器/附属扩展名(取各旧实现的并集)。 */
const ANY_EXT = new RegExp(`\\.(?:${VIDEO_EXT_ALT}|webm|xml|ass)$`, "i");

function leaf(nameOrPath: string): string {
  return nameOrPath.slice(Math.max(nameOrPath.lastIndexOf("/"), nameOrPath.lastIndexOf("\\")) + 1);
}

/** 剥掉不含扩展名的 stem 末尾的分段后缀。 */
export function stripSegmentSuffix(stem: string): string {
  return stem.replace(SEGMENT_SUFFIX_END, "");
}

/** 宽松会话基名:取 basename → 剥容器/附属扩展名 → 剥分段后缀。无段号/无时间戳的名字原样(去扩展名)返回。 */
export function sessionBaseOf(nameOrPath: string): string {
  return stripSegmentSuffix(leaf(nameOrPath).replace(ANY_EXT, ""));
}

/** 锚定会话基名:仅 `{x}_{YYYY-MM-DD}_{HH-MM-SS}[段后缀].(ts|flv|mp4|mkv|xml)` 返回基名,其余 undefined。 */
export function stampedSessionBaseOf(fileName: string): string | undefined {
  return STAMPED.exec(fileName)?.[1];
}

/** 段号(ts/flv/mp4/mkv/xml);无段后缀 = -1,使单文件排在所有分段之前。 */
export function segmentIndexOf(nameOrPath: string): number {
  const m = SEGMENT_INDEX.exec(leaf(nameOrPath));
  return m ? Number(m[1] ?? m[2] ?? m[3]) : -1;
}
