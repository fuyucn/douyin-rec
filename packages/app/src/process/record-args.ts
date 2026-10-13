/**
 * app/process/record-args.ts — PURE Task → `record` subcommand argv mapping.
 *
 * The ONLY job here is to translate a persisted Task into the argument vector
 * the `record` subcommand expects. No I/O, no spawning, no path resolution —
 * trivially unit-testable. The spawner (spawner.ts) prepends the cli entry and
 * any GLOBAL flags (e.g. --discord-webhook); this function emits only the
 * `record ...` portion.
 */
import type { Task } from "../store.js";
import { resolveOutputDir } from "../paths.js";

/**
 * Build the `record` subcommand argv for a task. Output shape:
 *   ["record", "--room", room, "--quality", q, "--engine", e,
 *    "--danmu", "1"|"0", "--out", dir, "--segment", String(sec),
 *    ...(name ? ["--name", name] : []),
 *    ...(cookiesFile ? ["--cookies-file", cookiesFile] : [])]
 *
 * 登录凭证(task.cookies)**永不**进 argv:调用方先把它写进 0600 文件(credential-file.ts),
 * 再把路径作 `cookiesFile` 传入。无文件路径 = 不带凭证 flag。
 */
export function buildRecordArgs(task: Task, cookiesFile?: string): string[] {
  const args = [
    "record",
    "--room",
    task.room,
    "--quality",
    task.quality,
    "--engine",
    task.engine,
    // 弹幕开关:1=开 0=关(来源由命中平台的 connectDanmu 提供,不再透传 provider 名)。
    "--danmu",
    task.danmu ? "1" : "0",
    "--out",
    // 与合成端(api recordingsDir)共用 resolveOutputDir → 录制/读取路径永远一致。
    // 子进程通过 spawn 继承父进程 env,故 DOUYIN_REC_OUTPUT/ROOT 在 serve 容器内可见。
    resolveOutputDir(task.outDir),
    "--segment",
    String(task.segmentSec),
  ];
  if (task.name) {
    // per-streamer output subfolder + filename prefix
    args.push("--name", task.name);
  }
  if (cookiesFile) {
    args.push("--cookies-file", cookiesFile);
  }
  // 边录边传(T-33):录制端**只读 master 派生的 `rollingEffective`**(issue #40),不读旧开关/规则;
  // 仅生效时下发(默认关 = 不带该 flag,行为不变)。
  if (task.rollingEffective) {
    args.push("--rolling-upload", "1");
  }
  return args;
}
