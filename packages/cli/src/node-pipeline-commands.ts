/**
 * node-pipeline-commands.ts — 节点侧上传(**experimental**,见 plans/027)的节点侧 CLI 命令。
 *
 * ⚠️ 实验功能:与 `@drec/app` 的 `node-pipeline.ts`(执行体)、orchestrator 的
 * `node-side-upload.ts`(master 侧调度 + kill switch)同属一组,**要移除时一起删**。
 *
 * 两个隐藏子命令(供 master 经 SSH 调用,不在 `--help` 显示):
 *   - `_node-capabilities <dataRoot>` → 探测 biliup/cookies/磁盘/字体(决定 master 是否走节点侧)。
 *   - `_node-pipeline <dataRoot> <base64>` → 节点本地 remux + biliup 上传,回传 BV(不含视频回传)。
 *   - `_node-result <dataRoot> <streamKey>` → 回读节点侧**落盘结果文件**(ssh 断线后的权威结果)。
 *   - `_node-abort <dataRoot> <streamKey>` → 终止该场的**节点执行体**(issue #2:master 判失败/收口后
 *     主动杀掉仍在跑的本场 `_node-pipeline` 及其 biliup/ffmpeg 子进程,杜绝「台账 failed、节点仍在建稿」)。
 */
import path from "node:path";
import type { Command } from "commander";

/**
 * ⚠️ 子命令的 `dataRoot` 必须在 **import @drec/app 之前** 写进 `DOUYIN_REC_ROOT`。
 *
 * `@drec/app` 的派生路径函数(`rootDbPath`/`rootBiliupCookies`/`rootStageDir`)在**调用时**读
 * `drecRoot()`(= `process.env.DOUYIN_REC_ROOT` 去空白,空则回落默认根 `./output-data`)。
 * master 经 ssh 调本命令时**不设**该 env(ssh 非登录 shell + systemd `Environment=` 为空),
 * 故 `dataRoot` 入参是节点数据根的**权威来源**,必须原样写进 env —— 否则各派生路径按
 * `./output-data` 解析:产物落错目录,且限流库父目录缺失 → sqlite 打不开 → UploadGate
 * fail-closed 静默冷却 30 分钟(线上实测整场「卡住」)。
 *
 * 放在 `await import("@drec/app")` 之前,是为了任何一次 @drec/app 导入求值前 env 就已就位
 * (纯防御:即便将来 paths.ts 又改回模块顶层求值也不出错)。
 */
export async function applyNodeDataRoot(dataRoot: string): Promise<void> {
  // 入参 dataRoot 才是权威(master 经 ssh 显式下发的节点数据根)。
  //
  // ⚠️ 曾经写成 `process.env.DOUYIN_REC_ROOT = drecRoot()`:env 为空时 `drecRoot()` 回落
  // **默认根 `./output-data`**(相对启动 cwd),于是把数据根错设成 `./output-data` ——
  // 节点侧产物落错位置(cwd 下的 output-data/stage 而非 `<root>/stage`),限流库路径
  // `<cwd>/output-data/db/douyin-rec.db` 的父目录不存在 → sqlite 打开失败 → UploadGate
  // **fail-closed 静默冷却 30 分钟**才尝试上传(线上实测:节点侧上传整场「卡住」不产出)。
  // 正确:直接把入参写进 env(绝对化,避免相对路径随 cwd 漂移)。
  const resolveRel = (r: string): string => (r.startsWith("/") ? r : path.resolve(r));
  process.env.DOUYIN_REC_ROOT = resolveRel(dataRoot);
}

/** 把节点侧上传的两个隐藏子命令挂到 program 上(experimental,plans/027)。 */
export function registerNodePipelineCommands(program: Command): void {
  // 节点侧上传能力探测:master 在 flag on 的房间上调用,决定走节点侧还是回落现状。
  program
    .command("_node-capabilities <dataRoot>", { hidden: true })
    .description("(内部) 输出节点侧上传能力 JSON(biliup/cookies/磁盘/字体;供 master ssh 调用)")
    .action(async (dataRoot: string) => {
      await applyNodeDataRoot(dataRoot);
      const { probeNodeCapabilities } = await import("@drec/app");
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
      await applyNodeDataRoot(dataRoot);
      const { runNodeSidePipeline } = await import("@drec/app");
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

  /**
   * 回读节点侧**落盘结果文件**。
   *
   * 为什么需要:`_node-pipeline` 是长命令(整场 remux + 上传),ssh 连接可能在命令跑完前断开
   * (tailscale stall / ServerAlive 判死)→ master 只看到 `ssh rc=255`,但节点上的上传**其实已成功**
   * (实测:建稿成功、private、多分 P)。master 用本命令**独立回读**落盘结果,把「真失败」与
   * 「回传断了但已成功」分开,不再把成功误判成 failed(误判 → 源不删 + 人工待办堆积)。
   *
   * 输出:结果 JSON 或 `null`(文件不存在/损坏)。命令**始终 exit 0** —— 它只是读一个文件,
   * 「读不到」是正常结果(master 按原失败路径处理),不是命令错误。
   */
  program
    .command("_node-result <dataRoot> <streamKey>", { hidden: true })
    .description("(内部) 回读节点侧上传落盘结果 JSON(experimental;供 master ssh 调用)")
    .action(async (dataRoot: string, streamKey: string) => {
      await applyNodeDataRoot(dataRoot);
      const { readNodeResult, rootStageDir } = await import("@drec/app");
      const { sanitizeStreamKey } = await import("@drec/core");
      const stageSub = path.join(rootStageDir(), sanitizeStreamKey(streamKey));
      const r = readNodeResult(stageSub);
      process.stdout.write(JSON.stringify(r ?? null) + "\n");
    });

  /**
   * 终止某 `streamKey` 的**节点执行体**(issue #2 A2)。
   *
   * 为什么需要:`_node-pipeline` 是 ssh 长命令,master 的 `runLong` 超时**只杀本地 ssh 客户端**,
   * 远端 node 进程及其 biliup/ffmpeg 子进程不受控继续 —— master 已把台账标 failed/needs_manual,
   * 节点却可能稍后**继续建稿**(重复投稿,B站不可逆)。master 判定终态失败后调用本命令把执行体收掉。
   *
   * 安全:`abortNodeExecutor` **先校验 pid 的 cmdline 确为本场 `_node-pipeline`**(防 pid 回收误杀),
   * 再 SIGTERM→宽限→SIGKILL 连子进程一并终止。非 Linux(本机开发)无 `/proc` → 返回不确定,绝不盲杀。
   *
   * 输出:`{ aborted, killed, detail }` JSON。**始终 exit 0** —— 终止失败/进程本就不在都是正常收口,
   * master 据 `aborted` 字段区分「确已停」与「无法确认」(后者保守转人工)。
   */
  program
    .command("_node-abort <dataRoot> <streamKey>", { hidden: true })
    .description("(内部) 终止该场的节点执行体及子进程(experimental;供 master ssh 调用)")
    .action(async (dataRoot: string, streamKey: string) => {
      await applyNodeDataRoot(dataRoot);
      const { abortNodeExecutor, rootStageDir } = await import("@drec/app");
      const { sanitizeStreamKey } = await import("@drec/core");
      const stageSub = path.join(rootStageDir(), sanitizeStreamKey(streamKey));
      try {
        const res = await abortNodeExecutor(stageSub, streamKey);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch (e) {
        // 任何异常也按「未确认终止」回报,绝不抛(不能掩盖 master 侧的原始失败原因)。
        process.stdout.write(JSON.stringify({ aborted: false, killed: [], detail: String((e as Error)?.message ?? e) }) + "\n");
      }
    });
}
