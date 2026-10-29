/**
 * link-or-copy.ts — 「硬链接优先、失败回落复制」的统一辅助(stage 拉取/分段/上传别名/节点侧共用)。
 *
 * 硬链接零拷贝;跨设备/挂载卷不支持(EXDEV/EPERM/EMLINK 等)时回落复制 —— 此前回落完全静默,
 * 每场多占一份整场体积却无人知晓。现在回落时上报 {原因错误码, 字节数},并按数据根只提示一次、之后计数。
 *
 * **原子替换目标**:目标可能已存在(续跑 / 上次被强杀留下的同名产物),先落同目录临时名再 rename ——
 * 读者(下游靠 `existsSync` 做续跑判定、以及上传)永远看不到「写了一半的最终名」。
 * 旧口径「调用方负责目标已存在先删」已作废;复制失败照常抛出。
 */
import { copyFileSync, linkSync, renameSync, rmSync, statSync } from "node:fs";
import { atomicTempName } from "./atomic-name.js";
import { createLogger } from "./log.js";

export interface LinkFs {
  linkSync(src: string, dst: string): void;
  copyFileSync(src: string, dst: string): void;
  statSync(p: string): { size: number };
  /** 原子替换用;**未注入时走真实 fs.renameSync**(注入只用于模拟 link/copy 失败的场景)。 */
  renameSync?(src: string, dst: string): void;
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

/**
 * 同目录临时名(rename 不跨设备;`.` 前缀隐藏)。**保留原扩展名** —— 各 stage 清理按扩展名
 * 识别视频类残留(`stageVideoLeftovers` 等),不保留扩展名的临时名会成为清理不到的磁盘泄漏。
 */
const scratchPath = atomicTempName;

/** 两个名字是否指向同一 inode(取不到/不存在 → false;只用于幂等跳过,判不出不影响正确性)。 */
function sameInode(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** 某数据根累计回落复制次数。 */
export function getLinkFallbackCount(root: string = process.env.DOUYIN_REC_ROOT ?? ""): number {
  return counts.get(root) ?? 0;
}

/** 仅测试用:清空计数。 */
export function resetLinkFallbackState(): void {
  counts.clear();
}

/**
 * 硬链接优先,失败回落复制。返回实际采用的方式。
 *
 * 两步落盘:硬链接/复制都先落 {@link scratchPath},再 `renameSync` 原子替换目标。
 * 为什么(2026-10-15 incident):被强杀的产物会以「最终名存在但内容不完整」的形态留下,
 * 下游把它当已完成产物复用 → 静默投稿坏分 P。目标名只允许出现「完整内容」。
 */
export function linkOrCopy(src: string, dst: string, opts?: LinkOrCopyOptions): "link" | "copy" {
  const fs = opts?.fs ?? realFs;
  // 同一 inode ⇒ 目标已经是产物本身,**什么都不要做**:再 link + rename 时 POSIX 规定
  // 「同一文件的两个硬链接之间 rename」是空操作,临时名会永久留下(每场泄漏一整个分 P);
  // 而第二次 link 会 EEXIST 误报「硬链接失败,回落复制」。
  // 触发场景很常见:上传 601 重试 / master 重启续跑都会重走这一段。
  if (sameInode(src, dst)) return "link";
  // 临时名与 post-process 的 `atomicPartPath` 同形(`.{basename}.part{ext}`)—— 两者**互斥**:
  // 同一最终名要么由 ffmpeg 原子写(`.part` 由 ffmpeg 持有),要么由本函数链/拷(此时没有 ffmpeg 在写)。
  // 若将来新增调用方破坏这个不变量,这里的 `rmSync` 会删掉别人正在写的临时文件。
  const tmp = scratchPath(dst);
  // 上次进程死在 link 与 rename 之间(或复制中途)会留下同名临时名 → 不先清掉的话 `linkSync` 报 EEXIST,
  // 我们会误报「硬链接失败,回落复制」并整文件多复制一遍。临时名是我们自己的产物,直接清。
  try { rmSync(tmp, { force: true }); } catch { /* 清不掉 → 按原行为继续(link 抛 → 走复制分支) */ }
  const rename = fs.renameSync ?? renameSync;
  try {
    fs.linkSync(src, tmp);
    rename(tmp, dst);
    return "link";
  } catch (err) {
    const code = String((err as NodeJS.ErrnoException)?.code ?? "UNKNOWN");
    fs.copyFileSync(src, tmp);
    rename(tmp, dst);
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
