/**
 * link-or-copy.ts — 「硬链接优先、失败回落复制」的统一辅助(stage 拉取/分段/上传别名/节点侧共用)。
 *
 * 硬链接零拷贝;跨设备/挂载卷不支持(EXDEV/EPERM/EMLINK 等)时回落复制 —— 此前回落完全静默,
 * 每场多占一份整场体积却无人知晓。现在回落时上报 {原因错误码, 字节数},并按数据根只提示一次、之后计数。
 *
 * 行为不变:调用方负责「目标已存在先删」;复制失败照常抛出。
 */
import { copyFileSync, linkSync, statSync } from "node:fs";
import { createLogger } from "./log.js";

export interface LinkFs {
  linkSync(src: string, dst: string): void;
  copyFileSync(src: string, dst: string): void;
  statSync(p: string): { size: number };
}

export interface LinkFallbackInfo {
  /** linkSync 的错误码(EXDEV/EPERM/…);无 code 时为 "UNKNOWN"。 */
  code: string;
  bytes: number;
  src: string;
  dst: string;
}

export interface LinkOrCopyOptions {
  fs?: LinkFs;
  /** 数据根标识(默认取 DOUYIN_REC_ROOT);同一 key 仅首次回落提示。 */
  root?: string;
  /** 每次回落都会调用(含计数之后)。 */
  onFallback?: (info: LinkFallbackInfo, count: number) => void;
  /** 首次回落的提示出口(默认 `[link]` warn 日志)。 */
  warn?: (msg: string) => void;
}

const realFs: LinkFs = { linkSync, copyFileSync, statSync };
const defaultLog = createLogger("link");
const counts = new Map<string, number>();

const rootKey = (o?: LinkOrCopyOptions): string => o?.root ?? process.env.DOUYIN_REC_ROOT ?? "";

/** 某数据根累计回落复制次数。 */
export function getLinkFallbackCount(root: string = process.env.DOUYIN_REC_ROOT ?? ""): number {
  return counts.get(root) ?? 0;
}

/** 仅测试用:清空计数。 */
export function resetLinkFallbackState(): void {
  counts.clear();
}

/** 硬链接优先,失败回落复制。返回实际采用的方式。 */
export function linkOrCopy(src: string, dst: string, opts?: LinkOrCopyOptions): "link" | "copy" {
  const fs = opts?.fs ?? realFs;
  try {
    fs.linkSync(src, dst);
    return "link";
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException)?.code ?? "UNKNOWN");
    fs.copyFileSync(src, dst);
    let bytes = 0;
    try { bytes = fs.statSync(dst).size; } catch { /* 取不到大小不影响主流程 */ }
    const key = rootKey(opts);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const info: LinkFallbackInfo = { code, bytes, src, dst };
    if (count === 1) {
      const msg = `硬链接失败,回落复制(${code},${(bytes / 1e9).toFixed(2)}GB):${dst} —— 每场会多占一份体积;本数据根后续回落只累计计数、不再提示`;
      (opts?.warn ?? defaultLog.warn)(msg);
    }
    opts?.onFallback?.(info, count);
    return "copy";
  }
}
