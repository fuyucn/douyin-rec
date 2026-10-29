// 产物「原子落盘 + 可读性自检」—— 后处理产物落盘口径的唯一真理源。
//
// 为什么必须原子(2026-10-15 线上 incident):
//   下游把「最终名存在」当「产物已完成」的**续跑判定依据**(segment-pipeline / node-pipeline
//   的 existsSync 跳过),而 ffmpeg 直接写最终名 —— 进程被强杀(卡死看门狗 / ssh 断 / 节点重启 /
//   磁盘满)会留下「大小看着完全正常、moov 没写完」的半成品。它会被下一轮当成品复用并**静默投稿**:
//   biliup 分块上传校验通过、B站建稿返回 `code: 0`,只在**转码阶段**才报 `state=-16 转码失败`
//   (实测残留文件 636,622,270B vs 源 636,643,728B,差 0.003%,`ffprobe` 报 moov 缺失)。
//   改成「先写 `.part` 再 rename」后:**存在 ⟹ 完整**,中途被杀只留临时文件。
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { atomicTempName } from "@drec/core";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * 临时产物名:同目录(rename 不能跨设备)、**保留扩展名**(ffmpeg 靠输出扩展名选容器)、`.` 前缀隐藏。
 * 例:`/x/凌晴_000.mp4` → `/x/.凌晴_000.part.mp4`。
 */
export function atomicPartPath(out: string): string {
  return atomicTempName(out);
}

/**
 * 把 ffmpeg 参数里的输出名换成临时名(输出恒为最后一个参数:见 `buildRemuxArgs` /
 * `buildBurnArgs` / `mergeSession` 的 concat 命令;新增调用方请保持这个不变量)。
 */
export function withAtomicOutput(args: readonly string[], out: string): string[] {
  return [...args.slice(0, -1), atomicPartPath(out)];
}

/**
 * 跑 ffmpeg 落 `out`:实际写 {@link atomicPartPath},rc=0 后 rename 成最终名。
 *
 * 失败(含看门狗强杀)时**不会**留下最终名 —— 半成品只在 `.part` 上,下一次运行 `-y` 覆盖它。
 */
export async function runFfmpegAtomic(
  args: readonly string[],
  out: string,
  opts?: Parameters<typeof runFfmpeg>[1],
): Promise<void> {
  // 统一 resolve:调用方可能传相对路径,而 ffmpeg 可能以**别的 cwd** 启动(burn 的 cwd=输出目录),
  // 且 buildRemuxArgs/buildBurnArgs 用的本就是 resolve 后的路径 —— 不统一会让「临时名与最终名」
  // 落在两个不同的相对基准上(相对路径调用直接失败)。
  const target = resolve(out);
  await runFfmpeg(withAtomicOutput(args, target), opts);
  renameSync(atomicPartPath(target), target);
}

/**
 * 自检:返回**读不出时长**的文件(probe 抛错或返回 ≤0),空数组 = 全部可读。
 *
 * 用途有二:① 复用既有中间产物之前判它是不是半成品;② 交给 biliup 之前拦住坏产物。
 * probe 由调用方注入(core/orchestrator 不依赖 ffmpeg 进程),生产传 `ffprobeDuration`。
 */
export async function unreadableParts(
  files: readonly string[],
  probe: (file: string) => Promise<number>,
): Promise<string[]> {
  const broken: string[] = [];
  for (const f of files) {
    let sec = 0;
    try {
      sec = await probe(f);
    } catch {
      sec = 0;
    }
    if (!(sec > 0)) broken.push(f);
  }
  return broken;
}

/**
 * 「这次能直接复用吗」= 文件存在 **且** 探得出时长(>0)。
 *
 * 存在但读不出 = 上次被强杀留下的半成品,复用它会静默投稿坏分 P —— 必须原地重做。
 */
export async function isCompleteMedia(
  file: string,
  probe: (f: string) => Promise<number>,
): Promise<boolean> {
  if (!existsSync(file)) return false;
  return (await unreadableParts([file], probe)).length === 0;
}
