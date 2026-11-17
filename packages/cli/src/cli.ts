import "./load-env.js";
import { Command } from "commander";
import { APP_VERSION, applyTimezoneFromDb, dbPathForDataRoot } from "@drec/app";
import "./providers-register.js";
import { registerRecordCommand } from "./record-command.js";
import { registerLivePumpCommand } from "./live-pump-command.js";
import { registerUposUploadCommand } from "./upos-upload-command.js";
import { registerDiagnosticCommands } from "./diagnostic-commands.js";
import { registerMergeCommand } from "./merge-command.js";
import { registerBurnCommand } from "./burn-command.js";
import { registerUploadCommand } from "./upload-command.js";
import { registerServiceCommands, registerRecheckCommand } from "./service-commands.js";
import { registerNodeCommands } from "./node-command-registration.js";
import { registerNodePipelineCommands } from "./node-pipeline-commands.js";
import { registerRecoverOrderCommands } from "./hub-recover-order-commands.js";

const program = new Command();
program
  .name("douyin-rec")
  .description("抖音直播录制 + 弹幕捕获 (TS, 单文件 CLI)")
  .version(APP_VERSION, "-v, --version", "显示版本号")
  // Non-server commands use the same persisted timezone as the daemon.
  .hook("preAction", (_cmd, action) => {
    if (action.name() === "serve") return;
    const dataRoot = action.name().startsWith("_") ? action.args[0] : undefined;
    if (dataRoot) applyTimezoneFromDb(dbPathForDataRoot(dataRoot));
    else applyTimezoneFromDb();
  })
  .option("--discord-webhook <url>", "Discord incoming webhook（也读 config / env DISCORD_WEBHOOK）")
  .option("--discord-webhook-file <path>", "从文件读取 Discord webhook (优先于 --discord-webhook)")
  .showHelpAfterError("(用 --help 查看用法)")
  .addHelpText(
    "after",
    `
示例:
  $ douyin-rec record --room 36464127515 --quality origin --danmu 1
  $ douyin-rec merge --in recordings
  $ douyin-rec burn --video out.mp4 --xml out.xml --style danmu
  $ douyin-rec task serve --port 7860 --db douyin-rec.db
`,
  );

registerRecordCommand(program);
registerUposUploadCommand(program);
registerLivePumpCommand(program);
registerDiagnosticCommands(program);
registerMergeCommand(program);
registerBurnCommand(program);
registerUploadCommand(program);
registerServiceCommands(program);
registerRecheckCommand(program);
registerNodeCommands(program);
registerNodePipelineCommands(program);
// Order recovery (plan 038 T11): dry-run by default.
registerRecoverOrderCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // Runtime errors exit 1; each command handles usage errors with exit 2.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[douyin-rec] 错误: ${msg}`);
  process.exit(1);
});
