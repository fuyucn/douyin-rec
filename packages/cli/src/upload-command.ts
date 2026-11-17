import type { Command } from "commander";
import { upload as biliUpload, checkBiliup, DEFAULT_COOKIES } from "@drec/app";
import { commandWebhook, toggledNotifier } from "./cli-notifier.js";
import { runWithUploadQuota } from "./upload-quota.js";

interface UploadOptions {
  video: string; title: string; tag: string; tid: string; public: boolean;
  desc?: string; cookiesFile: string; slotWait: string;
}

async function runUpload(program: Command, o: UploadOptions): Promise<void> {
  // A failed preflight exits without sending upload notifications.
  const err = await checkBiliup(o.cookiesFile);
  if (err) { console.error(`[upload] 预检失败: ${err}`); process.exit(2); return; }
  try {
    console.log(`[upload] ${o.title} (tid=${o.tid}, ${o.public ? "公开" : "仅自己可见"}) → 上传中…`);
    const slotWaitSec = Number(o.slotWait);
    const slotWaitMs = Number.isFinite(slotWaitSec) && slotWaitSec >= 0 ? slotWaitSec * 1000 : 600_000;
    const { bv } = await runWithUploadQuota(
      { cookiesPath: o.cookiesFile, log: (m) => console.error(`[upload] ${m}`), slotWaitMs },
      () => biliUpload({
        video: o.video, cookies: o.cookiesFile, title: o.title,
        tag: o.tag, tid: Number(o.tid), public: o.public, desc: o.desc,
      }),
    );
    console.log(`[upload] 完成: ${bv}  https://www.bilibili.com/video/${bv}`);
    await toggledNotifier(commandWebhook(program)).notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  } catch (e) {
    await toggledNotifier(commandWebhook(program)).notify({ kind: "error", stage: "upload", message: (e as Error).message });
    throw e;
  }
}

export function registerUploadCommand(program: Command): void {
  program
    .command("upload")
    .description("上传 mp4 到 B 站（包 biliup CLI）")
    .requiredOption("--video <mp4>", "要上传的 mp4")
    .requiredOption("--title <s>", "稿件标题")
    .option("--tag <csv>", "标签（逗号分隔）", "直播,直播录像,抖音")
    .option("--tid <n>", "分区 tid", "21")
    .option("--public", "公开（默认仅自己可见）", false)
    .option("--desc <s>", "简介")
    .option("--cookies-file <path>", "biliup cookies.json", DEFAULT_COOKIES)
    .option("--slot-wait <sec>", "等待本机上传槽位的上限秒数（默认 600；0=只检查一次）", "600")
    .action((o: UploadOptions) => runUpload(program, o));
}
