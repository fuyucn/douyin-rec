import type { Command } from "commander";
import { join } from "node:path";
import { runNodeCommandCli, notifyOutboxArgs } from "./node-commands.js";

async function printNodeIdentity(dataRoot: string) {
  const { ensureNodeIdentity } = await import("@drec/app");
  process.env.DOUYIN_REC_ROOT = dataRoot;
  process.stdout.write(JSON.stringify(ensureNodeIdentity()) + "\n");
}

async function joinFleet(dataRoot: string) {
  const { writeFleetConfig } = await import("@drec/app");
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const cfg = writeFleetConfig(join(dataRoot, "config", "fleet.json"), JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(JSON.stringify({ ok: true, nodeId: cfg.nodeId, controllerUrl: cfg.controllerUrl }) + "\n");
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    process.stdout.write(JSON.stringify({ ok: false, error }) + "\n");
    process.stderr.write(`_fleet-join: ${error}\n`);
    process.exitCode = 1;
  }
}

async function collectProcJobs(dataRoot: string, opts: { purgeFailed?: boolean }) {
  const { existsSync } = await import("node:fs");
  const { ProcQueueStore, procQueueDbPath } = await import("@drec/proc-queue");
  const dbPath = procQueueDbPath(dataRoot);
  let deleted = 0;
  if (existsSync(dbPath)) {
    const store = new ProcQueueStore(dbPath);
    try {
      deleted = store.gc({ purgeFailed: opts.purgeFailed === true });
    } finally {
      store.close();
    }
  }
  process.stdout.write(JSON.stringify({ deleted }) + "\n");
}

function registerNodeQueries(program: Command): void {
  program
    .command("_is-done <dataRoot> <roomSlug>", { hidden: true })
    .description("(内部) 判断该房间是否已收播(供 master ssh settle)")
    .action(async (dataRoot: string, roomSlug: string) => {
      await runNodeCommandCli("is-done", dataRoot, [roomSlug]);
    });
  program
    .command("_recording-status <dataRoot>", { hidden: true })
    .description("(内部) 输出当前正在录制的房间,供 master 控制台轮询")
    .action(async (dataRoot: string) => {
      await runNodeCommandCli("recording-status", dataRoot, []);
    });
  program
    .command("_inventory <dataRoot>", { hidden: true })
    .description("(内部) 扫描 <dataRoot>/recordings，输出 JSON 清单（供 master ssh 调用）")
    .action(async (dataRoot: string) => {
      await runNodeCommandCli("inventory", dataRoot, []);
    });
  program
    .command("_disk <dataRoot>", { hidden: true })
    .description("(内部) 输出数据根剩余空间 GB(供 master ssh 调用)")
    .action(async (dataRoot: string) => {
      await runNodeCommandCli("disk", dataRoot, []);
    });
  program
    .command("_tasks <dataRoot>", { hidden: true })
    .description("(内部) 输出节点任务清单 JSON(供 master ssh 调用)")
    .action(async (dataRoot: string) => {
      await runNodeCommandCli("tasks", dataRoot, []);
    });
  program
    .command("_task-logs <dataRoot> <taskId> <lines>", { hidden: true })
    .description("(内部) 输出某任务最近 n 行日志 JSON(供 master ssh 代查)")
    .action(async (dataRoot: string, taskIdRaw: string, linesRaw: string) => {
      await runNodeCommandCli("task-logs", dataRoot, [taskIdRaw, linesRaw]);
    });
  program
    .command("_node-status <dataRoot>", { hidden: true })
    .description("(内部) 输出节点应用回执 JSON(appVersion/appliedVersion/appliedAt/任务数;供 master ssh 调用)")
    .action(async (dataRoot: string) => {
      await runNodeCommandCli("node-status", dataRoot, []);
    });
}

function registerNodeUpdates(program: Command): void {
  program
    .command("_node-id <dataRoot>", { hidden: true })
    .description("(内部) 输出节点稳定身份 JSON(供 master ssh 调用;不存在则生成)")
    .action(printNodeIdentity);
  program
    .command("_fleet-join <dataRoot>", { hidden: true })
    .description("(内部) 从 stdin 写入节点长连接配置 config/fleet.json(供 master ssh 调用)")
    .action(joinFleet);
  program
    .command("_apply-tasks <dataRoot> <base64>", { hidden: true })
    .description("(内部) 应用 master 下发的期望任务(供 master ssh 调用)")
    .action(async (dataRoot: string, b64: string) => {
      await runNodeCommandCli("apply-tasks", dataRoot, [b64]);
    });
  program
    .command("_apply-cookies <dataRoot> <base64>", { hidden: true })
    .description("(内部) 应用 master 下发的平台登录态(供 master ssh 调用)")
    .action(async (dataRoot: string, b64: string) => {
      await runNodeCommandCli("apply-cookies", dataRoot, [b64]);
    });
  program
    .command("_notify-outbox <dataRoot>", { hidden: true })
    .option("--after <id>", "只取 id 大于该游标的事件")
    .option("--limit <n>", "本次最多返回多少条(默认 200)")
    .option("--ack <ids>", "逗号分隔的事件 id,读取后一并确认")
    .action(async (dataRoot: string, o: { after?: string; limit?: string; ack?: string }) => {
      await runNodeCommandCli("notify-outbox", dataRoot, notifyOutboxArgs(o));
    });
}

function registerNodeProcCommands(program: Command): void {
  program
    .command("_proc-gc <dataRoot>", { hidden: true })
    .option("--purge-failed", "额外清理 failed 行")
    .description("(内部) 清理节点处理任务表(done/cancelled > 7 天;可选 failed)")
    .action(collectProcJobs);
  program
    .command("_enqueue <dataRoot> <base64>", { hidden: true })
    .description("(内部) 入队处理任务(仅 remux;供 master ssh 调用)")
    .action(async (dataRoot: string, b64: string) => {
      await runNodeCommandCli("enqueue", dataRoot, [b64]);
    });
  program
    .command("_proc-status <dataRoot> <base64>", { hidden: true })
    .description("(内部) 查询处理任务回执(供 master ssh 调用)")
    .action(async (dataRoot: string, b64: string) => {
      await runNodeCommandCli("proc-status", dataRoot, [b64]);
    });
  program
    .command("_proc-cancel <dataRoot> <base64>", { hidden: true })
    .description("(internal) cancel processing jobs (called by the master over ssh)")
    .action(async (dataRoot: string, b64: string) => {
      await runNodeCommandCli("proc-cancel", dataRoot, [b64]);
    });
}

export function registerNodeCommands(program: Command): void {
  registerNodeQueries(program);
  registerNodeUpdates(program);
  registerNodeProcCommands(program);
}
