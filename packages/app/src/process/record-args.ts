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
 *    ...(cookies ? ["--cookies", cookies] : [])]
 */
export function buildRecordArgs(task: Task): string[] {
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
  if (task.cookies) {
    args.push("--cookies", task.cookies);
  }
  return args;
}
