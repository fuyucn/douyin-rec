/**
 * douyin-rec — 抖音直播录制 + 弹幕捕获 (TS, 单文件 CLI)。
 *
 * 用法（所有参数皆可命令行传入，无需 config）：
 *   douyin-rec record --room 36464127515 --quality origin --danmu 1
 *   douyin-rec record --room https://live.douyin.com/36464127515 --engine mesio --out ./recordings
 *   douyin-rec merge --in recordings
 *   douyin-rec burn --video recordings/野原_2026-06-10.mp4 --xml recordings/野原_2026-06-10.xml
 *
 * 设计：核心逻辑全在 core/，CLI 仅薄封装 → 二期 UI 复用同一核心。
 */
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { loadConfig } from "@drec/core";
import { RecordingSession } from "@drec/manager";
import "./providers-register.js"; // 副作用：注册内置平台 + 下载引擎
import { getEngine, platformForRoom } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import { groupSessions, mergeSession } from "@drec/post-process";
import { renderXmlToAss } from "@drec/post-process";
import { burn } from "@drec/post-process";
import { FONTS_DIR } from "@drec/post-process";
import { upload as biliUpload, checkBiliup, DEFAULT_COOKIES } from "@drec/app";
import type { Recorder, RecordOpts, NotifyEvent, Notifier } from "@drec/core";
import { makeNotifier } from "@drec/app";
import { buildTaskCommand, buildCookieCommand } from "@drec/app";

/** 从 CLI 全局选项 → config → env 三层解析 Discord webhook URL。 */
function webhookOf(localCfg?: { discordWebhook?: string }): string | undefined {
  return (program.opts() as { discordWebhook?: string }).discordWebhook
    ?? localCfg?.discordWebhook ?? process.env.DISCORD_WEBHOOK;
}

/** 房间号/URL → 规范直播 URL,按平台(URL 命中 / 裸房间号回落默认平台)。 */
function roomToUrl(room: string): string {
  return platformForRoom(room).roomToUrl(room);
}

/**
 * 解析 --danmu 开关(布尔):弹幕已收进平台(platform.connectDanmu),不再按 provider 名分派。
 *   0 / off / false / none → false(不抓)；其余(含 undefined/旧 provider 名)→ true(抓)。
 */
function parseDanmu(v: string | undefined): boolean {
  if (v === undefined) return true;
  return !["none", "0", "off", "false"].includes(v.trim().toLowerCase());
}

interface RecordCliOpts {
  room: string;
  name?: string;
  quality?: string;
  /** 下载引擎 id(ffmpeg / mesio);--recorder 为隐藏兼容别名,映射到此。 */
  engine?: string;
  recorder?: string;
  danmu?: string;
  cookies?: string;
  cookiesFile?: string;
  out?: string;
  segment?: string;
  danmuXmlMode?: string;
  reconnect?: string;
  config?: string;
}

const program = new Command();
program
  .name("douyin-rec")
  .description("抖音直播录制 + 弹幕捕获 (TS, 单文件 CLI)")
  .version(pkg.version, "-v, --version", "显示版本号")
  .option("--discord-webhook <url>", "Discord incoming webhook（也读 config / env DISCORD_WEBHOOK）")
  // 参数错误后顺带提示 --help，省得用户再敲一次。
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

// ─── record 子命令 ───────────────────────────────────────────────────────────
program
  .command("record")
  .description("录制抖音直播（含弹幕捕获）")
  .addHelpText(
    "after",
    `
例:
  $ douyin-rec record --room 36464127515 --danmu 1 --segment 1800
  $ douyin-rec record --room https://live.douyin.com/12345 --quality hd --out ./recordings`,
  )
  .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
  .option("--name <s>", "主播/输出名称（录像落在 {out}/{name}/ 子目录；留空则按抓取到的主播名自动分目录）")
  .option("--quality <q>", "画质: origin|uhd|hd|sd|ld (默认 origin)")
  .option("--engine <e>", "下载引擎(按平台: ffmpeg|mesio,省略=平台默认)")
  .option("--recorder <r>", "[已废弃别名] 等价 --engine")
  .option("--danmu <0|1>", "弹幕开关: 1=开(由平台 connectDanmu 提供) 0=关 (默认 1)")
  .option("--cookies <s>", "抖音 cookie 字符串")
  .option("--cookies-file <path>", "从文件读取 cookie (优先于 --cookies)")
  .option("--out <dir>", "输出目录 (默认 ./recordings)")
  .option("--segment <sec>", "分段时长(秒), 0=不分段 (默认 1800)")
  .option("--danmu-xml-mode <mode>", "弹幕 xml 粒度: session(整场一个,默认) | segment(逐段一个)")
  .option("--reconnect <sec>", "断流快速重连等待(秒) (默认 5)")
  .option("--config <path>", "YAML 配置文件 (命令行选项优先覆盖)")
  .action(async (o: RecordCliOpts) => {
    const cfg = loadConfig(o.config);

    // 平台驱动默认:命令行 --engine > 兼容别名 --recorder > config > 平台默认引擎。
    // 旧 config.recorder 可能是已废弃的录制器 provider 名(非引擎 id)→ getEngine 返 undefined,
    // 回落平台默认引擎(下面构造时兜底)。
    const platform = platformForRoom(o.room);
    const engineId = o.engine || o.recorder || cfg.recorder || platform.defaultEngine;
    // 弹幕退化为开关:on/off(来源由平台 connectDanmu 提供);config.danmu 旧值非 none 即视为开。
    const danmuEnabled = parseDanmu(o.danmu ?? cfg.danmu);

    let cookies = o.cookies ?? cfg.cookies;
    if (o.cookiesFile) cookies = readFileSync(o.cookiesFile, "utf-8").trim();

    const opts: RecordOpts = {
      quality: (o.quality ?? cfg.quality) as RecordOpts["quality"],
      cookies,
      outDir: o.out ?? cfg.outDir,
      segmentSec: o.segment !== undefined ? Number(o.segment) : cfg.segmentSec,
      name: o.name?.trim() || undefined,
      danmuXmlMode:
        (o.danmuXmlMode ?? cfg.danmuXmlMode) === "segment" ? "segment" : "session",
    };
    const reconnectDelaySec =
      o.reconnect !== undefined ? Number(o.reconnect) : cfg.reconnectDelaySec;

    const roomUrl = roomToUrl(o.room);

    // 通用录制器 + 选中的下载引擎(无字符串字面量分支)。非法/旧值回落平台默认引擎。
    // 弹幕来源由平台 connectDanmu 在 onLive 时提供(manager 内部),不再在此构造独立源。
    const engine = getEngine(engineId) ?? getEngine(platform.defaultEngine)!;
    const recorder: Recorder = new PollingRecorder(engine);

    const webhook = (program.opts() as { discordWebhook?: string }).discordWebhook ?? cfg.discordWebhook ?? process.env.DISCORD_WEBHOOK;
    // 告警双通道:webhook(makeNotifier)+ error 事件额外打一行 @@DREC_ALERT@@{json} 到 stdout,
    // 供父进程(TaskManager)解析 → EventCenter → 站内 toast(webhook 已由 makeNotifier 发,父进程不再重发)。
    const baseNotifier = makeNotifier(webhook);
    const notifier: Notifier = {
      notify: async (e: NotifyEvent): Promise<void> => {
        await baseNotifier.notify(e);
        if (e.kind === "error") {
          try {
            process.stdout.write(`@@DREC_ALERT@@${JSON.stringify({ stage: e.stage, message: e.message })}\n`);
          } catch {
            /* ignore */
          }
        }
      },
    };
    const session = new RecordingSession(recorder, { reconnectDelaySec, notifier, danmuEnabled });

    // 优雅停止 — 同时处理 SIGINT (Ctrl-C) 和 SIGTERM (kill / 进程管理器)。
    // 缺 SIGTERM handler 会导致 kill 时 node 直接退、不跑 stop()，孤儿 ffmpeg 继续录。
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[rec] 收到 ${sig}，正在停止…`);
      void session.stop().then(() => {
        console.log("[rec] 已停止");
        process.exit(0);
      }).catch((err: unknown) => {
        console.error("[rec] 停止时出错:", err);
        process.exit(1);
      });
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // SIGUSR2 = 窗口结束「优雅排空」：不腰斩当前直播，停掉开播轮询后等这场自然收播再退。
    // 与 SIGTERM(硬停) 区分；由调度 daemon 在定时窗口结束时发来。
    let draining = false;
    process.on("SIGUSR2", () => {
      if (stopping || draining) return;
      draining = true;
      console.log("[rec] 收到 SIGUSR2，窗口结束排空：等待当前直播自然收播…");
      void session.drain().then(() => {
        console.log("[rec] 排空完成，已停止");
        process.exit(0);
      }).catch((err: unknown) => {
        console.error("[rec] 排空出错:", err);
        process.exit(1);
      });
    });

    console.log(
      `[rec] recorder=${recorder.name} danmu=${danmuEnabled ? "on" : "off"} quality=${opts.quality} ` +
      `segment=${opts.segmentSec}s out=${opts.outDir}`
    );
    console.log(`[rec] 开始录制: ${roomUrl}`);

    await session.start(roomUrl, opts, { anchorName: "" });
    console.log("[rec] 录制中… Ctrl-C 停止");
  });

// ─── danmu-only 子命令（隔离测试）────────────────────────────────────────────
// 仅连弹幕 WS，不创建 recorder / 不录视频 / 不跑 RecordingSession（→ 无视频流、无 ffmpeg、
// 无流断开重连）。用于隔离验证「弹幕 WS 连接本身是否触发异地踢」，与视频侧重连风暴解耦。
program
  .command("danmu-only", { hidden: true }) // 隐藏：不出现在 --help，仅供内部排查（隔离弹幕 WS 测异地踢）
  .description("[内部] 仅连弹幕 WS、不录视频（隔离测试异地踢）")
  .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
  .option("--cookies <s>", "抖音 cookie 字符串")
  .option("--cookies-file <path>", "从文件读取 cookie (优先于 --cookies)")
  .option("--duration <sec>", "运行秒数后自动停止 (默认 240)")
  .action(async (o: { room: string; cookies?: string; cookiesFile?: string; duration?: string }) => {
    let cookies = o.cookies;
    if (o.cookiesFile) cookies = readFileSync(o.cookiesFile, "utf-8").trim();
    const opts: RecordOpts = { quality: "ld", cookies, outDir: "/tmp/danmu-only-noop", segmentSec: 0 };
    const roomUrl = roomToUrl(o.room);
    // 弹幕来源由平台提供(platform.connectDanmu);无能力(返 null)则该平台不支持弹幕。
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
  });

// ─── probe 子命令:录制前探测流信息(分辨率/码率/编码/横竖屏)─────────────────
program
  .command("probe")
  .description("录制前探测房间流信息:开播状态 + 各档画质的分辨率/码率/编码/帧率(匿名,不踢手机)")
  .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
  .action(async (o: { room: string }) => {
    const platform = platformForRoom(o.room);
    if (!platform.probe) {
      console.error(`平台 ${platform.id} 暂不支持 probe`);
      process.exit(2);
      return;
    }
    // Platform.probe 返回平台专属形状(unknown);抖音=StreamProbe。这里按 probe 的契约结构读取。
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
  });

// ─── merge 子命令 ────────────────────────────────────────────────────────────
program
  .command("merge")
  .addHelpText("after", `\n例:\n  $ douyin-rec merge --in recordings\n  $ douyin-rec merge --in recordings --base 主播_2026-06-11_15-01-27`)
  .description("合并会话分段 {base}-PART*.ts → {主播}_{日期}.mp4（上传命名约定；同日多会话保留时间戳区分）")
  .requiredOption("--in <dir>", "录像目录（含 {base}-PART*.ts / {base}.xml）")
  .option("--base <base>", "只合并指定会话基名（默认目录内全部会话）")
  .option("--keep-time", "输出保留会话时间戳 {base}.mp4（默认剥成 {主播}_{日期}.mp4）")
  .action(async (o: { in: string; base?: string; keepTime?: boolean }) => {
    const notifier = makeNotifier(webhookOf());
    try {
      const groups = groupSessions(readdirSync(o.in));
      const bases = o.base ? [o.base] : Object.keys(groups);
      // 会话 base = {主播}_{YYYY-MM-DD}_{HH-MM-SS};上传约定用 {主播}_{YYYY-MM-DD}。
      // 同日多会话(断流多场)会撞名 → 撞的保留完整 base(带时间戳),不撞的剥成 {主播}_{日期}。
      const dateName = (b: string): string => b.replace(/_\d{2}-\d{2}-\d{2}$/, "");
      const clash: Record<string, number> = {};
      for (const b of bases) clash[dateName(b)] = (clash[dateName(b)] ?? 0) + 1;
      for (const b of bases) {
        const g = groups[b];
        if (!g || g.ts.length === 0) { console.error(`[merge] 跳过 ${b}：无分段`); continue; }
        const outBase = o.keepTime || clash[dateName(b)] > 1 ? b : dateName(b);
        const out = join(o.in, `${outBase}.mp4`);
        console.log(`[merge] ${b}: ${g.ts.length} 段 → ${basename(out)}`);
        await mergeSession(g.ts.map((f) => join(o.in, f)), out);
        console.log(`[merge] 完成: ${out}`);
        await notifier.notify({ kind: "mergeDone", file: out });
      }
    } catch (e) {
      await makeNotifier(webhookOf()).notify({ kind: "error", stage: "merge", message: (e as Error).message });
      throw e;
    }
  });

// ffprobe 视频实际宽高 → 传给 ASS 渲染器,让 PlayRes 与视频一致(竖屏 1088x1920 不再被
// 当成默认横屏 1920x1080 拉伸 → 字号正常)。拿不到则回落 {}(渲染器用默认值)。
async function probeDim(video: string): Promise<{ width?: number; height?: number }> {
  try {
    const { ffprobeVideo } = await import("@drec/post-process");
    const { width, height } = await ffprobeVideo(video);
    return width > 0 && height > 0 ? { width, height } : {};
  } catch {
    return {};
  }
}

// ─── burn 子命令 ─────────────────────────────────────────────────────────────
program
  .command("burn")
  .addHelpText("after", `\n例:\n  $ douyin-rec burn --video out.mp4 --xml out.xml --style danmu --gift-value 0.9\n  $ douyin-rec burn --indir recordings --base 主播_2026-06-11 --style livechat`)
  .description("烧录弹幕 ASS → {video stem}_danmu.mp4 / {video stem}_livechat.mp4")
  .option("--video <mp4>", "已合并的 plain mp4（单文件模式；多段模式默认 {indir}/{base}.mp4）")
  .option("--xml <xml>", "会话弹幕 xml（单文件模式）")
  .option("--indir <dir>", "多段模式：含 {base}_NNN.ts + {base}_NNN.xml 的目录")
  .option("--base <base>", "多段模式：会话基名（如 主播_2026-06-11_15-01-27）")
  .option("--style <s>", "danmu|livechat", "danmu")
  .option("--gift-value <n>", "礼物价值过滤阈值", "0.9")
  .option("--out <mp4>", "输出（默认 {video stem}_{style}.mp4）")
  .option("--hwaccel <h>", "auto|videotoolbox|none", "auto")
  .action(async (o: { video?: string; xml?: string; indir?: string; base?: string; style: string; giftValue: string; out?: string; hwaccel: string }) => {
    if (o.style !== "danmu" && o.style !== "livechat") {
      console.error("[burn] --style 仅支持 danmu | livechat"); process.exit(2); return;
    }
    const suffix = o.style === "livechat" ? "_livechat.mp4" : "_danmu.mp4";
    try {
      let ass: string, label: string, video: string;

      if (o.indir && o.base) {
        // ── 多段模式：每段 xml 按前序 .ts 累计时长平移 → 合并到一条时间轴 ──
        const { renderSegmentsToAss } = await import("@drec/post-process");
        const groups = groupSessions(readdirSync(o.indir));
        const g = groups[o.base];
        if (!g || g.segmentXmls.length === 0) {
          console.error(`[burn] ${o.base}: 在 ${o.indir} 找不到 per-segment xml（{base}_NNN.xml）`);
          process.exit(2); return;
        }
        // segmentXmls[i] 与 ts[i] 对齐；若数量不齐，按较短的对齐（缺时长按 0）
        const n = Math.min(g.ts.length, g.segmentXmls.length);
        const segments = Array.from({ length: n }, (_, i) => ({
          xmlPath: join(o.indir!, g.segmentXmls[i]),
          tsPath: join(o.indir!, g.ts[i]),
        }));
        video = o.video ?? join(o.indir, `${o.base}.mp4`);
        const dim = await probeDim(video);
        const r = await renderSegmentsToAss(segments, o.style as "danmu" | "livechat", { giftValueFilter: Number(o.giftValue), ...dim });
        ass = r.ass;
        label = o.style === "livechat" ? `${r.count} 行(livechat, ${n} 段)` : `${r.count} 弹幕(${n} 段)`;
      } else if (o.video && o.xml) {
        // ── 单文件模式（原行为）──
        const xml = readFileSync(o.xml, "utf-8");
        video = o.video;
        const dim = await probeDim(video);
        if (o.style === "livechat") {
          const { renderXmlToLivechat } = await import("@drec/post-process");
          const r = renderXmlToLivechat(xml, { giftValueFilter: Number(o.giftValue), ...dim });
          ass = r.ass; label = `${r.count} 行(livechat)`;
        } else {
          const r = renderXmlToAss(xml, { giftValueFilter: Number(o.giftValue), ...dim });
          ass = r.ass; label = `${r.danmaku} 弹幕`;
        }
      } else {
        console.error("[burn] 需 --video + --xml（单文件）或 --indir + --base（多段）");
        process.exit(2); return;
      }

      const out = o.out ?? resolve(video).replace(/\.mp4$/i, suffix);
      console.log(`[burn] ${basename(video)} + ${label} → ${basename(out)}`);
      await burn({ inputMp4: video, assText: ass, outMp4: out, fontsDir: FONTS_DIR, hwaccel: o.hwaccel as "auto" });
      console.log(`[burn] 完成: ${out}`);
      await makeNotifier(webhookOf()).notify({ kind: "burnDone", style: o.style, file: out });
    } catch (e) {
      await makeNotifier(webhookOf()).notify({ kind: "error", stage: "burn", message: (e as Error).message });
      throw e;
    }
  });

// ─── upload 子命令 ───────────────────────────────────────────────────────────
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
  .action(async (o: { video: string; title: string; tag: string; tid: string; public: boolean; desc?: string; cookiesFile: string }) => {
    // 预检失败直接 exit 2，不发通知（在 try 之外）
    const err = await checkBiliup(o.cookiesFile);
    if (err) { console.error(`[upload] 预检失败: ${err}`); process.exit(2); return; }
    try {
      console.log(`[upload] ${o.title} (tid=${o.tid}, ${o.public ? "公开" : "仅自己可见"}) → 上传中…`);
      const { bv } = await biliUpload({
        video: o.video, cookies: o.cookiesFile, title: o.title,
        tag: o.tag, tid: Number(o.tid), public: o.public, desc: o.desc,
      });
      console.log(`[upload] 完成: ${bv}  https://www.bilibili.com/video/${bv}`);
      await makeNotifier(webhookOf()).notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
    } catch (e) {
      await makeNotifier(webhookOf()).notify({ kind: "error", stage: "upload", message: (e as Error).message });
      throw e;
    }
  });

// ─── task 子命令组（stateful app 层：sqlite 持久化 + 运行任务）─────────────────
// webhook 解析复用全局 --discord-webhook / env DISCORD_WEBHOOK（settings 表在 runTask 内兜底）。
// 用 `||` 而非 `??`:env `DISCORD_WEBHOOK=`(set-but-empty,docker .env 常见)会让 `??` 透出空串,
// 进而毒化下游 `getWebhook() ?? settings.discordWebhook` 链(?? 不接空串)→ UI 设的全局 webhook
// 永远读不到。空串一律归一为 undefined,下游 `??` 才能正确回落到 settings 表。
program.addCommand(
  buildTaskCommand(
    () =>
      (program.opts() as { discordWebhook?: string }).discordWebhook ||
      process.env.DISCORD_WEBHOOK ||
      undefined,
  ),
);

// ─── cookie 子命令组：管理全局抖音账号 cookie（所有任务共享）────────────────────
program.addCommand(buildCookieCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  // 运行期错误统一走这里：干净的一行写 stderr + 退出码 1（参数/校验错由各命令 exit 2）。
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[douyin-rec] 错误: ${msg}`);
  process.exit(1);
});
