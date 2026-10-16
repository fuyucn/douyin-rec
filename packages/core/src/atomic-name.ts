/**
 * 原子落盘临时名的唯一真理源(写 `.part` → rename):生成与识别共用,不另写正则。
 * 形如 `.{basename}.part{ext}`:同目录(rename 不跨设备)、`.` 前缀隐藏、**保留原扩展名**
 * (ffmpeg 靠扩展名选容器;stage 清理按扩展名认视频类残留)。
 */
import { basename, dirname, extname, join } from "node:path";

const PART_INFIX = ".part";

/** 最终名 → 同目录临时名。例:`/x/a_000.mp4` → `/x/.a_000.part.mp4`。 */
export function atomicTempName(out: string): string {
  const ext = extname(out);
  return join(dirname(out), `.${basename(out, ext)}${PART_INFIX}${ext}`);
}

/** 文件名(basename 或路径)是否原子落盘的临时名:`.` 前缀 + 扩展名前带 `.part` 中缀。 */
export function isAtomicTempName(name: string): boolean {
  const b = basename(name);
  if (!b.startsWith(".")) return false;
  const stem = b.slice(0, b.length - extname(b).length);
  return stem.length > PART_INFIX.length + 1 && stem.endsWith(PART_INFIX);
}
