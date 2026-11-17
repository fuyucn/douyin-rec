import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { platformForRoom, type RecordOpts } from "@drec/core";

function roomToUrl(room: string): string { return platformForRoom(room).roomToUrl(room); }

async function runDanmuOnly(o: { room: string; cookies?: string; cookiesFile?: string; duration?: string }) {
  let cookies = o.cookies;
  if (o.cookiesFile) cookies = readFileSync(o.cookiesFile, "utf-8").trim();
  const opts: RecordOpts = { quality: "ld", cookies, outDir: "/tmp/danmu-only-noop", segmentSec: 0 };
  const roomUrl = roomToUrl(o.room);
  const platform = platformForRoom(roomUrl);
  const source = platform.connectDanmu?.({ roomUrl, channelId: platform.extractRoomSlug(roomUrl), opts }) ?? null;
  if (!source) {
    console.error(`[danmu-only] 平台 ${platform.id} 无弹幕能力(connectDanmu 返回 null)`);
    process.exit(1);
    return;
  }
  const counts: Record<string, number> = { danmaku: 0, gift: 0, member: 0 };
  const dur = o.duration !== undefined ? Number(o.duration) : 240;
  console.log(`[danmu-only] platform=${platform.id} cookie=${cookies ? `有(${cookies.length}字符)` : "无(匿名)"} room=${roomUrl}`);

  await source.start(roomUrl, opts, (m) => { counts[m.kind] = (counts[m.kind] ?? 0) + 1; });

  const t0 = Date.now();
  const iv = setInterval(() => {
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] 弹幕=${counts.danmaku} 礼物=${counts.gift} 入场=${counts.member}`);
  }, 60_000);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(iv);
    await source.stop().catch(() => {});
    console.log(`[danmu-only] 最终: 弹幕=${counts.danmaku} 礼物=${counts.gift} 入场=${counts.member}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  setTimeout(() => void stop(), dur * 1000);
  console.log(`[danmu-only] 连接中… ${dur}s 后自动停止。盯手机看是否被踢。`);
}

async function runProbe(o: { room: string }) {
  const platform = platformForRoom(o.room);
  if (!platform.probe) {
    console.error(`平台 ${platform.id} 暂不支持 probe`);
    process.exit(2);
    return;
  }
  interface ProbeQuality { desc: string; key: string; bitRate: number; resolution?: string; vcodec?: string; fps?: number }
  interface ProbeResult { living: boolean; owner: string; title: string; orientation?: string; device?: string; qualities: ProbeQuality[] }
  const p = (await platform.probe(o.room)) as ProbeResult;
  if (!p.living) {
    console.log(`未开播（或无法获取流）: ${o.room}`);
    return;
  }
  console.log(`主播: ${p.owner}  |  标题: ${p.title}  |  ${p.orientation ?? "?"}  |  设备: ${p.device ?? "?"}`);
  console.log(`可选画质（${p.qualities.length}）:`);
  for (const q of p.qualities) {
    const parts = [
      q.desc.padEnd(4),
      q.resolution ? q.resolution.padEnd(10) : "?".padEnd(10),
      q.vcodec ? q.vcodec.padEnd(8) : "?".padEnd(8),
      q.fps ? `${q.fps}fps` : "",
      q.bitRate ? `${(q.bitRate / 1_000_000).toFixed(2)}Mbps` : "",
    ];
    console.log(`  ${parts.join("  ")}`);
  }
}

export function registerDiagnosticCommands(program: Command): void {
  program
    .command("danmu-only", { hidden: true })
    .description("[内部] 仅连弹幕 WS、不录视频（隔离测试异地踢）")
    .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
    .option("--cookies <s>", "抖音 cookie 字符串")
    .option("--cookies-file <path>", "从文件读取 cookie (优先于 --cookies)")
    .option("--duration <sec>", "运行秒数后自动停止 (默认 240)")
    .action(runDanmuOnly);
  program
    .command("probe")
    .description("录制前探测房间流信息:开播状态 + 各档画质的分辨率/码率/编码/帧率(匿名,不踢手机)")
    .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
    .action(runProbe);
}
