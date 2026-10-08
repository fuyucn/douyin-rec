/**
 * node-pipeline-commands.ts — 节点侧上传(**experimental**,见 plans/027)的节点侧 CLI 命令。
 *
 * ⚠️ 实验功能:与 `@drec/app` 的 `node-pipeline.ts`(执行体)、orchestrator 的
 * `node-side-upload.ts`(master 侧调度 + kill switch)同属一组,**要移除时一起删**。
 *
 * 两个隐藏子命令(供 master 经 SSH 调用,不在 `--help` 显示):
 *   - `_node-capabilities <dataRoot>` → 探测 biliup/cookies/磁盘/字体(决定 master 是否走节点侧)。
 *   - `_node-pipeline <dataRoot> <base64>` → 节点本地 remux + biliup 上传,回传 BV(不含视频回传)。
 */
import type { Command } from "commander";

/** 把节点侧上传的两个隐藏子命令挂到 program 上(experimental,plans/027)。 */
export function registerNodePipelineCommands(program: Command): void {
  // 节点侧上传能力探测:master 在 flag on 的房间上调用,决定走节点侧还是回落现状。
  program
    .command("_node-capabilities <dataRoot>", { hidden: true })
    .description("(内部) 输出节点侧上传能力 JSON(biliup/cookies/磁盘/字体;供 master ssh 调用)")
    .action(async (dataRoot: string) => {
      const { probeNodeCapabilities } = await import("@drec/app");
      process.env.DOUYIN_REC_ROOT = dataRoot;
      try {
        process.stdout.write(JSON.stringify(await probeNodeCapabilities(dataRoot)) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
        process.exitCode = 1;
      }
    });

  // 节点本地 remux(+可选聚组)→ biliup 上传 → 回传 BV。**不含视频回传**(省掉 rsync 的关键)。
  program
    .command("_node-pipeline <dataRoot> <base64>", { hidden: true })
    .description("(内部) 在节点本地执行 remux + biliup 上传并回传 BV(experimental;供 master ssh 调用)")
    .action(async (dataRoot: string, b64: string) => {
      const { runNodeSidePipeline } = await import("@drec/app");
      process.env.DOUYIN_REC_ROOT = dataRoot;
      const spec = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as import("@drec/core").NodePipelineSpec;
      try {
        const result = await runNodeSidePipeline(spec, (m) => process.stderr.write(`[node-pipeline] ${m}\n`));
        process.stdout.write(JSON.stringify(result) + "\n");
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }) + "\n");
        process.exitCode = 1;
      }
    });
}
