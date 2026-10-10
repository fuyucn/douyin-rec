/**
 * mesio 下载引擎 — mesio(rust-srec 的 mesio-cli)落盘 .flv(+ 分段)。
 *
 * 提炼自原 douyin-live-mesio-recorder / bilibili-live-mesio-recorder(两者除来路 header 外一致;
 * header 现经 EngineSpawnArgs.headers → `-H 'K: V'` 透传,故合并为一个引擎)。mesio 自带 FLV/HLS
 * 一致性修复(--fix)+ 按时长分段(-d)。产物 .flv 分段 {nameBase}_%i.flv(对齐 concat 会话分组)。
 *
 * 进度上报:mesio 无 ffmpeg 的 `time=` 进度,改用「输出目录 .flv 总大小是否增长」喂 markProgress
 * (返回 cleanup 清掉 setInterval)。会话首段路径 = {nameBase}_000.flv(mesio 自管多段、无逐段回调)。
 */
import { join } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { DownloadEngine, EngineSpawnArgs, EngineSpawnResult } from "@drec/core";

/**
 * mesio 二进制定位(按优先级):
 *   1. `MESIO_PATH` 环境变量(docker 用,见 Dockerfile `ENV MESIO_PATH=/app/bin/mesio`);
 *   2. 仓库约定路径 `<cwd>/bin/mesio`(本地从仓库根起 serve 时直接命中,install-mesio.sh 装到这);
 *   3. 回落裸 `mesio`(交给 PATH)。
 * 之前只有 1+3:本地起 serve 没设 MESIO_PATH 且 PATH 无 ./bin → `spawn mesio ENOENT` 死循环重连。
 */
export function resolveMesioBin(): string {
  if (process.env.MESIO_PATH) return process.env.MESIO_PATH;
  const repoBin = join(process.cwd(), "bin", "mesio");
  if (existsSync(repoBin)) return repoBin;
  return "mesio";
}
const MESIO = resolveMesioBin();

/** 输出文件增长看门狗检查间隔(对齐原录制器的 STALL_CHECK_MS=15s)。 */
const FILE_WATCH_MS = 15_000;

/** 构造 mesio argv(纯函数,便于单测)。 */
export function buildMesioArgs(a: Pick<EngineSpawnArgs, "url" | "headers" | "dir" | "nameBase" | "segSec">): string[] {
  // mesio -n 模板:%i=段号(3 位补零)。对齐 ffmpeg 版命名 {nameBase}_{NNN}.flv,
  // 使 concat.ts 的会话分组正则能识别(只是容器是 .flv 非 .ts)。
  const nameTpl = `${a.nameBase}_%i`;
  const headerArgs = a.headers ? Object.entries(a.headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]) : [];
  const args = [a.url, "-o", a.dir, "-n", nameTpl, "--fix", "--disable-log-file", ...headerArgs];
  if (a.segSec > 0) args.push("-d", `${a.segSec}s`);
  return args;
}

/**
 * mesio 可运行性自检:跑 `--version`,2 秒超时。
 *
 * 为什么不能只看「文件存在 + 可执行」:实测 VPS 上的 mesio 需要 GLIBC 2.38/2.39,
 * 而 Ubuntu 22.04 只有 2.35 → 二进制存在、权限也对,但**一执行就报 GLIBC 缺失并退出**。
 * 只看文件属性会放它过去,然后录制反复失败(短命录制 → 退避到 300s),用户很久才发现
 * 「看起来在录、实际没落盘」。所以这里**真的执行一次**。
 *
 * 只判「能否启动」,不判版本是否符合预期 —— 版本是 install 脚本的职责(单一真理源),
 * 这里只回答「这台机器上跑不跑得起来」。
 */
export function probeMesio(): string | null {
  const bin = resolveMesioBin();
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 2000, encoding: "utf-8" });
    if (r.error) {
      const e = r.error as NodeJS.ErrnoException;
      return e.code === "ENOENT" ? `mesio 不存在: ${bin}` : `mesio 无法启动(${e.code ?? "error"}): ${e.message}`;
    }
    if (r.status !== 0) {
      // 最常见的失败:GLIBC 版本不足。把 stderr 首行带出来,别让用户去猜。
      const why = String(r.stderr ?? "").trim().split("\n")[0] || `退出码 ${r.status}`;
      return `mesio 启动失败: ${why}`;
    }
    return null;
  } catch (e) {
    return `mesio 自检异常: ${(e as Error)?.message ?? e}`;
  }
}

export const mesioEngine: DownloadEngine = {
  id: "mesio",
  probe: probeMesio,
  spawn(a: EngineSpawnArgs): EngineSpawnResult {
    const args = buildMesioArgs(a);
    const proc = spawn(MESIO, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", (d: Buffer) => {
      const s = String(d).trim();
      if (s) a.pushStderr(s);
    });

    // 文件增长看门狗:每 FILE_WATCH_MS 扫 dir 下 .flv 总大小,增长则 markProgress。
    let lastTotalBytes = -1;
    const fileWatch = setInterval(() => {
      let total = 0;
      try {
        for (const f of readdirSync(a.dir)) {
          if (!/\.flv$/i.test(f)) continue;
          try { total += statSync(join(a.dir, f)).size; } catch { /* 文件正写/刚删 */ }
        }
      } catch { return; } // 目录还没建好
      if (total > lastTotalBytes) { lastTotalBytes = total; a.markProgress(); }
    }, FILE_WATCH_MS);
    fileWatch.unref?.();

    return {
      proc,
      sessionFirstPath: join(a.dir, `${a.nameBase}_000.flv`),
      cleanup: () => clearInterval(fileWatch),
    };
  },
};
