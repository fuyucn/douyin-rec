import type { Command } from "commander";
import { createHubStarter } from "@drec/hub-compose";
import { biliAccountKey } from "@drec/bilibili-api";
import { buildTaskCommand, buildCookieCommand, resolveUploadAccountKey, hubStageDir, hubLogsDir, type HubStarter } from "@drec/app";
import { deleteHubHistory } from "@drec/orchestrator";
import { NODE_COMMANDS, localRoomProbes } from "./node-commands.js";

function masterUploadAccountKey(warn: (m: string) => void): string {
  try {
    return resolveUploadAccountKey();
  } catch (e) {
    warn(`[upload-gate] 读取本机 biliup cookies 失败,限流并入 unknown 桶: ${(e as Error).message}`);
    return biliAccountKey(null);
  }
}

export function registerServiceCommands(program: Command): void {
  const hubStarter: HubStarter = createHubStarter({
    localRoomProbes: (dataRoot, _probeDeps, fallback) => localRoomProbes(dataRoot, undefined, fallback),
    masterUploadAccountKey,
  });

  const taskCmd = buildTaskCommand(
    () =>
      (program.opts() as { discordWebhook?: string }).discordWebhook ||
      process.env.DISCORD_WEBHOOK ||
      undefined,
    hubStarter,
  );

  taskCmd
    .command("serve")
    .description("启动 Web 控制台：HTTP 服务 + SPA + 定时调度守护（默认开；--no-schedule 关）")
    .option("--port <n>", "监听端口（默认 7860）")
    .option("--host <host>", "监听地址（默认回环；all=所有网卡；远程访问需配置共享密钥）")
    .option("--db <path>", "数据库路径")
    .option("--no-schedule", "关闭定时调度，仅手动启停（默认开启调度）")
    .option("--hub", "启用多节点同步编排(默认关)")
    .option("--hub-config <json|path>", "hub 配置(JSON 串或文件路径);省略则自动读 <root>/config/hub-config.json")
    .action(async (o: { port?: string; host?: string; db?: string; schedule?: boolean; hub?: boolean; hubConfig?: string }) => {
      const { runServe } = await import("@drec/app");
      await runServe(o, {
        getWebhook: () =>
          (program.opts() as { discordWebhook?: string }).discordWebhook ||
          process.env.DISCORD_WEBHOOK ||
          undefined,
        hubStarter,
        fleetCommands: NODE_COMMANDS,
        deleteHubHistory: (syncDbPath, roomKey) =>
          deleteHubHistory({ syncDbPath, roomKey, stageDir: hubStageDir(), logsDir: hubLogsDir() }),
      });
    });

  program.addCommand(taskCmd);

  program.addCommand(buildCookieCommand());
}

export function registerRecheckCommand(program: Command): void {
  program
    .command("recheck-verify")
    .description("重核 needs_manual 的分P 核验假失败(默认 dry-run,--apply 才落库)")
    .option("--apply", "真的把判定一致的 job 翻回 done(默认只打印)")
    .option("--key <streamKey>", "只查某一场(如 douyin:123:2026-10-11)")
    .option("--cookies <path>", "biliup cookies.json 路径")
    .action(async (o: { apply?: boolean; key?: string; cookies?: string }) => {
      const { runRecheck } = await import("./hub-recheck-run.js");
      await runRecheck({
        apply: o.apply === true,
        ...(o.key ? { keys: [o.key] } : {}),
        ...(o.cookies ? { cookies: o.cookies } : {}),
      });
    });
}
