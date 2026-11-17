import type { Command } from "commander";
import { tmpdir } from "node:os";
import { platformForRoom } from "@drec/core";
import { alignFileSize, DEFAULT_SEGMENT_CAP, runLivePump, type RunLivePumpResult } from "@drec/zero-upload";
import { buildLivePumpSubmitter } from "./live-pump-submitter.js";

interface ManualPumpOptions {
  cookies: string; size: string; segments: string; maxSec?: string; spoolDir?: string;
  title?: string; tid: string; tag: string; line: string; private: boolean; submit?: boolean;
}

function writeResult(room: string, sizeCap: number, result: RunLivePumpResult): void {
  const out: Record<string, unknown> = {
    ok: result.ok, room, sizeCap, segments: result.segments, spoolDir: result.spoolDir,
    submitted: !!result.bvid, bvid: result.bvid, aid: result.aid,
    title: result.title, parts: result.segments.length,
    ...(result.error ? { error: result.error } : {}),
    ...(result.archiveExists ? { archiveExists: true } : {}),
  };
  process.stderr.write("[直播直传] 状态保留在 " + result.statePath + "(确认过的 spool 已清理)\n");
  process.stdout.write(JSON.stringify(out) + "\n");
  if (!result.ok) process.exitCode = 1;
}

async function runManualPump(room: string, options: ManualPumpOptions): Promise<void> {
  const platform = platformForRoom(room);
  const sizeCap = alignFileSize(Number(options.size));
  if (sizeCap !== Number(options.size)) {
    process.stderr.write("[直播直传] size " + options.size + " 未按 10MiB 对齐 → 用 " + sizeCap + "\n");
  }
  const spoolDir = options.spoolDir ?? tmpdir() + "/live-pump";
  const pumpRoom = platform.extractRoomSlug(platform.roomToUrl(room));
  const log = (message: string): void => { process.stderr.write(message + "\n"); };
  const submitter = buildLivePumpSubmitter({
    cookiesPath: options.cookies, spoolDir, pumpRoom, log,
  });
  const result = await runLivePump({
    submitter, cookiesPath: options.cookies, room: pumpRoom, spoolDir, sizeCap,
    fetch: async (roomId, quality) => {
      const stream = await platform.getStream(roomId, quality);
      return { living: stream.living, ...(stream.url ? { url: stream.url } : {}),
        ...(stream.headers ? { headers: stream.headers } : {}) };
    },
    quality: platform.defaultQuality ?? "origin",
    title: options.title ?? "测试-" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""),
    tid: Number(options.tid), tag: options.tag, private: options.private !== false,
    maxMs: options.maxSec && Number(options.maxSec) > 0 ? Number(options.maxSec) * 1000 : undefined,
    maxSegments: Math.max(1, Number(options.segments)), line: options.line,
    submit: options.submit === true, log,
  });
  writeResult(room, sizeCap, result);
}

/** Archive publication is opt-in; the default still uploads a bounded test part to UPOS. */
export function registerLivePumpCommand(program: Command): void {
  program.command("_live-pump <room>", { hidden: true })
    .description("[内部] 直播间边录边传 PoC:ffmpeg -fs 分段 → UPOS 直传 → 建私稿")
    .requiredOption("--cookies <path>", "biliup cookies.json 路径")
    .option("--size <bytes>", "分段字节上界(默认 " + DEFAULT_SEGMENT_CAP +
      " = 对齐后的 1.5GiB;须 10MiB 对齐)", String(DEFAULT_SEGMENT_CAP))
    .option("--segments <n>", "最多录几段(默认 1;调试用)", "1")
    .option("--max-sec <sec>", "时长阈值(秒):与 --size 谁先到算一 P。0/缺省 = 只用字节兜底")
    .option("--spool-dir <dir>", "spool 目录(默认系统临时目录)")
    .option("--title <title>", "稿件标题(默认 测试-<timestamp>)")
    .option("--tid <tid>", "投稿分区(默认 21 生活-日常)", "21")
    .option("--tag <tag>", "标签(逗号分隔)", "测试")
    .option("--line <line>", "上传线路(默认 txa)", "txa")
    .option("--private", "仅自己可见(默认)", true)
    .option("--submit", "真的建稿(缺省只跑一段到 complete,不建稿)")
    .action(runManualPump);
}
