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
  } else if (task.anchorName) {
    // Zero-disk tasks have no filename to inherit the anchor from; pass the already-resolved
    // anchor so title templates and danmu metadata do not fall back to the numeric room slug.
    args.push("--name", task.anchorName);
  }
  if (cookiesFile) {
    args.push("--cookies-file", cookiesFile);
  }
  // 边录边传(T-33):录制端**只读 master 派生的 `rollingEffective`**(issue #40),不读旧开关/规则;
  // 仅生效时下发(默认关 = 不带该 flag,行为不变)。
  // 0 落盘(plans/039)优先:两者同时为真时不传 `--rolling-upload`,避免 `record` 互斥检查退出 2。
  if (task.rollingEffective && !task.streamUpload) {
    args.push("--rolling-upload", "1");
  }
  // 0 落盘边录边传:ffmpeg 管道 stdout → UPOS 直传,源录像不落盘。与 rolling 互斥(见上)。
  if (task.streamUpload) {
    args.push("--stream-upload", "1");
    // 默认保留 spool(可整文件回退);显式关掉 = 真 0 落盘,失败无本地回退。
    if (task.streamUploadSpool === false) args.push("--stream-upload-spool", "none");
  }
  // 节点侧原地替换(issue #137):`task.outputFormat` 在这里已是**判定后的生效值**(TaskManager.spawnFor 经
  // resolveNodeOutputFormat 算定:hub 受管 / 有规则绑定 / 边录边传 → original)。original = 不带 flag,行为不变。
  if (task.outputFormat && task.outputFormat !== "original") {
    // 任务标识只给封口转换队列用(入队行归属任务 → serve 侧失败告警按任务归属);无 outputFormat 时无人消费,不带。
    if (typeof task.id === "number") args.push("--task-id", String(task.id));
    args.push("--output-format", task.outputFormat); // 保持末尾(既有用例/约定)
  }
  return args;
}
