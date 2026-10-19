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
import "./load-env.js"; // 副作用:必须最先 import——从 <cwd>/.env 灌 env(如 DOUYIN_REC_ROOT),
                         // 抢在下面 @drec/app 的 DEFAULT_COOKIES(模块加载时就读 env)求值之前生效。
import { SyncGate } from "./sync-gate.js";
import { streamPartMaxMs } from "./stream-part-duration.js";
import { Command } from "commander";
// 节点侧上传(experimental,plans/027)的节点侧命令(隔离在独立文件,便于快速开关/回退)。
import { applyNodeDataRoot, registerNodePipelineCommands } from "./node-pipeline-commands.js";
import { registerRecoverOrderCommands } from "./hub-recover-order-commands.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { biliAccountKey, burnFlags, effectiveStageFormat, closeStageReady, isUploadingMode, loadConfig, parseOutputFormat, stageExt, resolveDiskMinGB, sanitizeStreamKey, ttlMemoAsync, freeGBOf, redactLogLines } from "@drec/core";
import type { EnqueueRequest, HubResources, ProcActiveDTO, OutputFormat, StageFormat } from "@drec/core";
import { RecordingSession, XmlDanmuWriter } from "@drec/manager";
import "./providers-register.js"; // 副作用：注册内置平台 + 下载引擎
import { decorateRecordEvent, getEngine, listProcessors, platformForRoom, resolveSpecAssignment, type DownloadEngine } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import { groupSessionsInDir, mergeSession, mergeSessions } from "@drec/post-process";
import { renderXmlToAss } from "@drec/post-process";
import { burn } from "@drec/post-process";
import { FONTS_DIR } from "@drec/post-process";
import { upload as biliUpload, checkBiliup, DEFAULT_COOKIES, rootOutputDir } from "@drec/app";
import { isJobAbort, isJobLive, registerChild, runWithJob, throwIfAborted, USER_STOP, type Recorder, type RecordOpts, type NotifyEvent, type Notifier, type RemoteTaskSpec, type RecordingWorkerStatusDTO, type RollingDeliveryDTO, type HubPoolSnapshotDTO, type NodeTaskLogsDTO, type NodeTasksDTO, type WorkerStatus } from "@drec/core";
import { makeNotifier, shouldSendWebhook, webhookTogglesFromEnv, resolveUploadAccountKey, type NotifWebhookToggles } from "@drec/app";
import { buildTaskCommand, buildCookieCommand, resolveHubConfig, readManagedState, refreshLocalRollingEffective, rollingSpecFields, APP_VERSION, syncDbPathFor } from "@drec/app";
import type { HubStarter, TaskStore } from "@drec/app";
import { applyTimezoneFromDb, dbPathForDataRoot, effectiveTimezone } from "@drec/app";
import type { UploadOpts } from "@drec/core";
import type { PipelineCfg, SyncLedger, WorkflowNodeKey } from "@drec/orchestrator";
import { recordStreamUpload } from "@drec/orchestrator";
import { DEFAULT_SEGMENT_CAP } from "@drec/zero-upload";

/**
 * master 侧上传限流的**账号分键**(030 T19):从本机 biliup cookies 解析 DedeUserID →
 * `bilibili:<mid>`。节点侧上传(node-pipeline)用**同一个**键 → 同账号的冷却/窗口跨节点共享
 * (B 站按账号限流)。解析不出 → `bilibili:unknown`(保守并桶)。键算法唯一真理 = core/upload-gate.ts。
 */
function masterUploadAccountKey(warn: (m: string) => void): string {
  try {
    return resolveUploadAccountKey();
  } catch (e) {
    warn(`[upload-gate] 读取本机 biliup cookies 失败,限流并入 unknown 桶: ${(e as Error).message}`);
    return biliAccountKey(null);
  }
}

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
  rollingUpload?: string;
  /** Streaming zero-disk upload: ffmpeg stdout → UPOS chunks → one archive (default off). */
  streamUpload?: string;
  streamUploadSize?: string;
  streamUploadSec?: string;
  streamUploadTid?: string;
  streamUploadTag?: string;
  streamUploadPrivate?: string;
  streamUploadSpool?: string;
  outputFormat?: string;
  taskId?: string;
  config?: string;
}

/**
 * 带类型开关的 Discord 通知器:serve 经 `DREC_WEBHOOK_TOGGLES` 注入到子进程环境,
 * 关闭的类别不发 webhook(仍保留站内 @@DREC_ALERT@@ 通道)。手工跑 CLI 无 env → 全关。
 */
function toggledNotifier(
  webhook: string | undefined,
  toggles: NotifWebhookToggles = webhookTogglesFromEnv(),
): Notifier {
  const base = makeNotifier(webhook);
  return {
    notify: async (e: NotifyEvent): Promise<void> => {
      if (shouldSendWebhook(toggles, e)) await base.notify(e);
    },
  };
}

const program = new Command();
program
  .name("douyin-rec")
  .description("抖音直播录制 + 弹幕捕获 (TS, 单文件 CLI)")
  .version(APP_VERSION, "-v, --version", "显示版本号")
  // 时区唯一真理源 = settings.timezone。`task serve` 启动时自己应用(runServe);其余入口
  // (独立 record / merge / burn / upload / 隐藏命令)不经 serve,这里统一从库里读同一设置,
  // 否则会落回宿主机本地时区、算出错一天的文件名/标题(issue #155)。
  .hook("preAction", (_cmd, action) => {
    if (action.name() === "serve") return;
    // 带 <dataRoot> 的隐藏命令(_inventory 等)按传入数据根读库:ssh 会话无 DOUYIN_REC_*,默认路径通常无库(issue #158)。
    const dataRoot = action.name().startsWith("_") ? action.args[0] : undefined;
    if (dataRoot) applyTimezoneFromDb(dbPathForDataRoot(dataRoot));
    else applyTimezoneFromDb();
  })
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
/**
 * 选下载引擎,并在**引擎不可运行**时回落到 ffmpeg(兜底引擎)。
 *
 * 为什么需要回落:`mesio` 是外部二进制,可能「文件在、可执行位也对」但跑不起来
 * (实测 VPS:需要 GLIBC 2.38/2.39,系统只有 2.35 → 每次 spawn 立即退出 code=1)。
 * 没有回落时表现为:会话判定「短命录制」→ 指数退避(最长 300s)→ **界面显示录制中、
 * 磁盘一个字节不涨**,用户要很久才发现。有回落则在起播前就切到 ffmpeg,录制照常。
 *
 * 只回落一次(不回落到自己),避免「mesio 坏了 → 回落 mesio」的死循环。
 * 回落时**必须留日志**(stderr),不能静默 —— 否则用户不知道自己的引擎选择没生效。
 */
function pickEngine(requestedId: string, platformDefaultId: string): DownloadEngine {
  const requested = getEngine(requestedId) ?? getEngine(platformDefaultId);
  if (!requested) throw new Error(`没有可用引擎(请求 ${requestedId},平台默认 ${platformDefaultId})`);
  if (!requested.probe) return requested;
  const why = requested.probe();
  if (why === null) return requested;
  const fallback = getEngine("ffmpeg");
  if (!fallback || fallback.id === requested.id) {
    // 没有可回落的引擎(或本身就是 ffmpeg):**明确报错**,不能带着坏引擎继续录。
    throw new Error(`录制引擎 ${requested.id} 不可用: ${why};且无可回落的 ffmpeg 引擎`);
  }
  // 回落是**重要**的状态变更:用 stderr 让它在 serve 日志/任务日志里可见。
  process.stderr.write(`[rec] 引擎 ${requested.id} 不可用(${why})→ 已回落到 ${fallback.id}\n`);
  return fallback;
}

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
  .option("--out <dir>", "输出目录 (默认 <DOUYIN_REC_ROOT>/recordings,未设根则 output-data/recordings)")
  .option("--segment <sec>", "分段时长(秒), 0=不分段 (默认 1800)")
  .option("--danmu-xml-mode <mode>", "弹幕 xml 粒度: session(整场一个,默认) | segment(逐段一个)")
  .option("--reconnect <sec>", "断流快速重连等待(秒) (默认 5)")
  .option("--rolling-upload <0|1>", "边录边传: 1=录制中每封口一段就上传并删该段源 0=整场录完再处理 (默认 0)")
  .option("--stream-upload <0|1>", "流式直传(0 落盘): 1=ffmpeg stdout 直传 UPOS 并续同一稿件,上传确认后删 spool;0=关闭(默认)")
  .option("--stream-upload-size <bytes>", "流式直传每 P 字节上界(默认对齐后的 1GiB)")
  .option("--stream-upload-sec <sec>", "流式直传每 P 时长阈值(秒),与 --stream-upload-size 谁先到算一 P")
  .option("--stream-upload-tid <tid>", "流式直传投稿分区(默认 21)")
  .option("--stream-upload-tag <tag>", "流式直传标签(逗号分隔)", "直播,录像")
  .option("--stream-upload-spool <full|none>", "流式直传是否保留本地 spool: full=可整文件回退(默认), none=真 0 落盘", "full")
  .option("--stream-upload-private <0|1>", "流式直传仅自己可见(默认 1)", "1")
  .option("--output-format <fmt>", "节点侧输出格式 original|mp4|mkv: 分段封口后原地 remux 成所选容器、校验通过后删原文件 (默认 original=不转)")
  .option("--task-id <n>", "所属任务 id(serve 拉起时传入;封口转换入队行据此归属任务,失败告警按任务显示)")
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
      // 留空(未传 --out、YAML 也未设 outDir)→ 回落 rootOutputDir()
      // (<DOUYIN_REC_ROOT ?? DEFAULT_ROOT>/recordings)。
      outDir: o.out || cfg.outDir || rootOutputDir(),
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
    const engine = pickEngine(engineId, platform.defaultEngine);
    const recorder: Recorder = new PollingRecorder(engine);

    const webhook = (program.opts() as { discordWebhook?: string }).discordWebhook ?? cfg.discordWebhook ?? process.env.DISCORD_WEBHOOK;
    // 告警双通道:webhook(makeNotifier)+ error 事件额外打一行 @@DREC_ALERT@@{json} 到 stdout,
    // 供父进程(TaskManager)解析 → EventCenter → 站内 toast(webhook 已由 makeNotifier 发,父进程不再重发)。
    const toggles = webhookTogglesFromEnv();
    const baseNotifier = toggledNotifier(webhook, toggles);
    const notifier: Notifier = {
      notify: async (e: NotifyEvent): Promise<void> => {
        await baseNotifier.notify(e);
        if (e.kind === "error") {
          try {
            // ctx (issue #53 N4) is an extra field: an older parent ignores it, a newer parent forwards it.
            process.stdout.write(`@@DREC_ALERT@@${JSON.stringify({ stage: e.stage, message: e.message, ...(e.ctx ? { ctx: e.ctx } : {}) })}\n`);
          } catch {
            /* ignore */
          }
        }
      },
    };
    // 边录边传(T-33,默认关):开启时注入「每会话一个」上传钩子工厂(metadata 读 hub 规则/hub.config);
    // 关闭时 undefined → session 完全不启用,行为与改动前一致。开关 0/1/on/off/true/false(与 task-input 同套假值)。
    const rollingEnabled = o.rollingUpload !== undefined
      && !["0", "off", "false", "no", "none"].includes(o.rollingUpload.trim().toLowerCase());
    let makeRolling: (() => import("@drec/manager").RollingUploadHook) | undefined;
    if (rollingEnabled) {
      const { makeRollingUploadHookFactory } = await import("@drec/app");
      const slug = platform.extractRoomSlug(roomToUrl(o.room));
      makeRolling = makeRollingUploadHookFactory({
        enabled: true,
        platform: platform.id,
        roomSlug: slug,
        log: (m: string) => console.log(m),
      });
      console.log(`[rec] 边录边传已开启:每封口一段上传后删该段源(room=${slug})`);
    }
    const streamUploadEnabled = o.streamUpload !== undefined
      && !["0", "off", "false", "no", "none"].includes(o.streamUpload.trim().toLowerCase());
    // streaming upload replaces the file-based recorder; running both would pull the same
    // stream twice and upload a duplicate archive, so it must be mutually exclusive.
    if (streamUploadEnabled && rollingEnabled) {
      console.error("[rec] --stream-upload 与 --rolling-upload 互斥,请只开一个");
      process.exit(2);
    }
    if (streamUploadEnabled) {
      // 直连新包(不再经 processors re-export):生产路径的依赖要明确,否则"换实现"
      // 看起来像改 processors,容易连带碰到后处理插件层。
      const { runLivePump, alignFileSize, DEFAULT_SEGMENT_CAP, readLivePumpState, livePumpStatePath } = await import("@drec/zero-upload");
      const { rootBiliupCookies, sweepOrphanSpools } = await import("@drec/app");
      const sizeCap = alignFileSize(Number(o.streamUploadSize ?? DEFAULT_SEGMENT_CAP));
      const streamTitle = o.name?.trim() || platform.extractRoomSlug(roomToUrl(o.room));
      const cookies = o.cookiesFile ?? process.env.BILIUP_COOKIE ?? rootBiliupCookies();
      console.log(
        `[rec] 流式直传(0 落盘)已开启:room=${o.room} sizeCap=${sizeCap} ` +
        `sec=${o.streamUploadSec ?? (Number(o.segment ?? 0) > 0 ? `${o.segment}(--segment)` : "字节兜底")} ` +
        `tid=${o.streamUploadTid ?? "21"}`,
      );
      // Danmu still goes to disk on the zero-disk path (the only artifact that does).
      // The pump stays platform-agnostic; this layer owns the platform source + xml writer.
      const danmuSource = o.danmu === "0"
        ? null
        : platform.connectDanmu?.({
            roomUrl: roomToUrl(o.room),
            channelId: platform.extractRoomSlug(roomToUrl(o.room)),
            opts: {
              quality: (o.quality ?? cfg.quality ?? platform.defaultQuality) as RecordOpts["quality"],
              cookies: o.cookies,
              outDir: opts.outDir,
              segmentSec: 0,
            },
          }) ?? null;
      const xmlPath = join(opts.outDir, `live-pump-${platform.extractRoomSlug(roomToUrl(o.room))}.xml`);
      const writer = danmuSource ? new XmlDanmuWriter() : null;
      let writerOpened = false;
      const danmu = danmuSource && writer ? {
        xmlPath,
        start: async (): Promise<void> => {
          // Anchor to the wall clock at connect time: parts are sealed by byte/duration, so a
          // single session-level axis is the only stable reference for burn/part slicing.
          const startMs = Date.now();
          writer.open(xmlPath, { anchorName: streamTitle, roomId: platform.extractRoomSlug(roomToUrl(o.room)), videoStartMs: startMs });
          writerOpened = true;
          await danmuSource.start(roomToUrl(o.room), {
            quality: (o.quality ?? cfg.quality ?? platform.defaultQuality) as RecordOpts["quality"],
            cookies: o.cookies,
            outDir: opts.outDir,
            segmentSec: 0,
          }, (m) => writer.add(m), (msg) => console.error(`[live-pump] ⚠️ 弹幕: ${msg}`));
        },
        stop: async (): Promise<void> => {
          await danmuSource.stop().catch(() => {});
          if (writerOpened) writer.close();
        },
      } : undefined;
      if (danmuSource) console.log(`[rec] 弹幕落盘(唯一落盘产物): ${xmlPath}`);
      // Remove spools left by a pump killed mid-part. They never reached the state file, so
      // nothing else would ever delete them. Only old, unreferenced files are touched.
      const st = readLivePumpState(livePumpStatePath(opts.outDir, o.room));
      sweepOrphanSpools({
        spoolDir: opts.outDir,
        knownSpoolPaths: st?.parts.map((p) => p.spoolPath) ?? [],
        log: (m) => console.log(m),
      });
      const abort = new AbortController();
      const onSig = (sig: string): void => {
        console.log(`[stream-upload] 收到 ${sig},停止录制并中止当前分 P`);
        abort.abort();
      };
      process.on("SIGINT", () => onSig("SIGINT"));
      process.on("SIGTERM", () => onSig("SIGTERM"));
      // Window-end drain (SIGUSR2). Registered *before* the pump starts so a window-end signal
      // always finds a handler: Node's default for an unhandled SIGUSR2 is immediate process
      // death (measured: exit 159), which cuts the in-flight part mid-upload. In
      // `--stream-upload-spool none` there is no local copy of that part, so the video is lost
      // for good. It would also be reported as a clean exit: `stopGraceful` marks the child
      // `expected` *before* sending the signal, so the task log would claim
      // "直播自然收播，排空完成" for a broadcast that was never drained.
      const drain = new AbortController();
      process.on("SIGUSR2", () => {
        if (drain.signal.aborted) return; // the daemon re-sends every tick; idempotent
        drain.abort();
      });
      const run = runLivePump({
        cookiesPath: cookies,
        room: o.room,
        fetch: async (r, q) => {
          const s = await platform.getStream(r, q);
          return { living: s.living, ...(s.url ? { url: s.url } : {}), ...(s.headers ? { headers: s.headers } : {}) };
        },
        quality: (o.quality ?? cfg.quality ?? platform.defaultQuality) as RecordOpts["quality"],
        spoolDir: opts.outDir,
        title: streamTitle,
        tid: Number(o.streamUploadTid ?? "21"),
        tag: o.streamUploadTag ?? "直播,录像",
        private: o.streamUploadPrivate !== "0",
        sizeCap,
        maxMs: streamPartMaxMs(o.streamUploadSec, o.segment),
        maxSegments: 0,
        submit: true,
        spoolMode: o.streamUploadSpool === "none" ? "none" : "full",
        signal: abort.signal,
        drainSignal: drain.signal,
        danmu,
        log: (m) => console.log(m),
      }).then((res) => {
        console.log(`[stream-upload] ${JSON.stringify(res)}`);
        // Record the upload outcome in the hub ledger. A zero-disk run leaves no recording
        // files for the pipeline to scan, so without this the room would never show an outcome.
        // Best effort: the archive already exists, so a ledger failure must not fail the run.
        if (res.ok && res.bvid) {
          const roomSlug = platform.extractRoomSlug(roomToUrl(o.room));
          const r = recordStreamUpload({
            syncDbPath: syncDbPathFor(dbPathForDataRoot(process.env.DOUYIN_REC_ROOT ?? process.cwd())),
            streamKey: `${platform.id}:${roomSlug}:${new Date().toISOString().slice(0, 10)}`,
            bvid: res.bvid,
            parts: res.segments.length,
          });
          console.log(r.ok
            ? `[stream-upload] 台账已记录: ${r.bvid}${r.alreadyTerminal ? "(已是终态,未覆盖)" : ""}`
            : `[stream-upload] ⚠️ 台账记录失败(不影响已上传稿件): ${r.error}`);
        }
        process.exit(res.ok ? 0 : 1);
      }).catch((e) => {
        console.error(`[stream-upload] 失败: ${(e as Error).message}`);
        process.exit(1);
      });
      // The pump owns the whole process, so it owns signal handling too (the shared handlers
      // are installed further down and this path returns before them). Without the abort,
      // stopping a zero-disk task leaves the current ffmpeg orphaned.
      // The streaming pump owns the whole process: no file recorder, no second ffmpeg.
      return;
    }
    // 节点侧原地替换容器(issue #137):子进程只**信** `--output-format`(是否适用已由 spawn 前的唯一判定点
    // resolveNodeOutputFormat 算定,受管 / 有规则 / 边录边传都不会带该参数)。与边录边传互斥,rolling 优先(它上传后删源)。
    // 非法值直接报错退出,不静默回落 —— 静默回落会让用户以为在转、实际没转。
    let closeRemuxQueue: () => Promise<void> = async () => {};
    let nodeFormat: OutputFormat = "original";
    try { nodeFormat = parseOutputFormat(o.outputFormat); }
    catch (e) { console.error(`[rec] ${(e as Error).message}`); process.exit(2); }
    if (nodeFormat !== "original" && makeRolling) {
      console.log(`[rec] 已开启边录边传,忽略 --output-format ${nodeFormat}(上传后删源,与原地替换互斥)`);
    } else if (nodeFormat !== "original") {
      const fmt = nodeFormat as StageFormat;
      const { makeNodeRemuxHookFactory, recoverNodeRemuxInBackground, RemuxQueue } = await import("@drec/app");
      const remuxDeps = {
        log: (m: string) => console.log(m),
        // 失败走现有告警通道(error 事件 → webhook + @@DREC_ALERT@@ → 站内 toast),不静默。
        // Same context as the session's own notifications (issue #53 N4): task name, platform, room id.
        alert: (message: string) => {
          const e = decorateRecordEvent({ kind: "error", stage: "转封装", message } as NotifyEvent,
            { taskName: opts.name, platform: platform.id, roomSlug: platform.extractRoomSlug(o.room) });
          void notifier.notify(e).catch(() => {});
        },
        // 任务归属标识(临时文件名 = 归属 + pid):接管据此区分「本任务已死进程的残留」与「别的任务的新鲜残留」。
        owner: platform.extractRoomSlug(o.room),
      };
      // 会话开始前接管上次崩溃留下的中间态:**后台执行、不挡开录**(探测挂死/慢盘不得拖住录制),整体有总时限。
      // 目录级接管只兜底「不在任务表里」的旧 tmp / 配对;表内 job 由 runner 的租约接管 + recover 续跑。
      void recoverNodeRemuxInBackground(opts.outDir, fmt, remuxDeps);
      // 封口转换走每节点任务表(plans/036 T6):本进程按租约规则宿主 runner(serve 先持有则只入队)。
      // 打不开 → null(已告警),钩子回落进程内串行转换。
      const taskIdNum = o.taskId !== undefined && /^\d+$/.test(o.taskId) ? Number(o.taskId) : undefined;
      const queue = RemuxQueue.open({ owner: remuxDeps.owner, taskId: taskIdNum, outDir: opts.outDir, alert: remuxDeps.alert, log: remuxDeps.log });
      if (queue) {
        closeRemuxQueue = () => queue.close();
        process.on("exit", () => queue.releaseLeaseSync());
      }
      makeRolling = makeNodeRemuxHookFactory({ format: fmt, ...remuxDeps, queue });
      console.log(`[rec] 节点侧输出格式 ${fmt}:每封口一段入队原地 remux(${queue ? "任务表" : "进程内串行(任务表不可用)"}),校验通过后删原文件`);
    }
    // 新一场开播的磁盘水位闸门(issue #96):常驻任务的下一场开播此前不过闸门,低水位后仍会开新一场直至写满盘。
    // 每次判定现读 hub 配置(水位热改生效)并测**任务自己的输出目录**所在卷;只拦新一场,同场重连放行。
    const { makeNewBroadcastGate, effectiveHubConfig } = await import("@drec/app");
    const effHub = effectiveHubConfig();
    const admitNewBroadcast = makeNewBroadcastGate({
      outDir: opts.outDir,
      hubConfigPath: effHub.path,
      hubConfigJson: effHub.json,
      warn: (m: string) => console.warn(m),
    });
    const session = new RecordingSession(recorder, { reconnectDelaySec, notifier, danmuEnabled, makeRolling, admitNewBroadcast });

    // 优雅停止 — 同时处理 SIGINT (Ctrl-C) 和 SIGTERM (kill / 进程管理器)。
    // 缺 SIGTERM handler 会导致 kill 时 node 直接退、不跑 stop()，孤儿 ffmpeg 继续录。
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n[rec] 收到 ${sig}，正在停止…`);
      void session.stop().then(() => closeRemuxQueue()).then(() => {
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
      void session.drain().then(() => closeRemuxQueue()).then(() => {
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
// (internal) Direct UPOS streaming upload for a local file (PoC, no biliup CLI).
// Input: base64(JSON {files: string[], title: string, tid: number, tag: string, private: boolean}).
// Output: {ok, bvid?, aid?, parts: [{file, cid, bytes, ms}]}
program
  .command("_upos-upload <dataRoot> <base64>", { hidden: true })
  .description("(internal) stream local files straight to UPOS and create a private archive")
  .action(async (dataRoot: string, b64: string) => {
    try {
      await applyNodeDataRoot(dataRoot);
      const { preupload, uploadChunks, complete, submitStudio, UposRateLimited } = await import("@drec/zero-upload");
      const { readFileSync, statSync } = await import("node:fs");
      const req = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as {
        files: string[]; title: string; tid: number; tag: string; private?: boolean;
      };
      if (!req.files?.length) throw new Error("files must not be empty");
      const cookies = process.env.BILIUP_COOKIE ?? join(dataRoot, "config", "biliup", "cookies.json");
      if (!existsSync(cookies)) throw new Error(`cookies 不存在: ${cookies}`);
      const parts: Array<{ file: string; stem: string; bytes: number; ms: number }> = [];
      const videos: Array<{ filename: string; title: string }> = [];
      for (const file of req.files) {
        if (!existsSync(file)) throw new Error(`文件不存在: ${file}`);
        const t0 = Date.now();
        const buf = readFileSync(file);
        const name = basename(file);
        // B 站对「连续建新分 P」会 601 限流(实测:多 P 连传时第 7 个开始的 preupload 被拒)。
        // 冷却是唯一解——重试本身没错,只是要退后。指数退避封顶 5 分钟,最多 8 次。
        let session!: Awaited<ReturnType<typeof preupload>>;
        for (let attempt = 0; ; attempt++) {
          try {
            session = await preupload({ cookiesPath: cookies, fileName: name, totalSize: buf.length, line: "txa" });
            break;
          } catch (e) {
            if (!(e instanceof UposRateLimited) || attempt >= 8) throw e;
            const wait = Math.min(30_000 * 2 ** attempt, 300_000);
            process.stderr.write(`[upos] 601 限流,${wait / 1000}s 后重试 preupload (第 ${attempt + 1} 次): ${name}\n`);
            await new Promise((r) => setTimeout(r, wait));
          }
        }
        const chunks = await uploadChunks({
          session, totalSize: buf.length,
          readChunk: async (i, size) => buf.subarray(i * session.bucket.chunkSize, i * session.bucket.chunkSize + size),
        });
        const done = await complete({ session, parts: chunks });
        if (!done.ok) throw new Error(`complete 失败: ${JSON.stringify(done.raw).slice(0, 400)}`);
        const stem = done.stem;
        if (!stem) throw new Error(`complete 未返回可用 UPOS stem: ${JSON.stringify(done.raw).slice(0, 400)}`);
        parts.push({ file: name, stem, bytes: buf.length, ms: Date.now() - t0 });
        videos.push({ filename: stem, title: name.replace(/\.[^.]+$/, "") });
      }
      const r = await submitStudio({
        cookiesPath: cookies, title: req.title, tid: req.tid, tag: req.tag,
        private: req.private !== false, videos,
      });
      if (!r.ok) throw new Error(`submit 失败: ${JSON.stringify(r.raw).slice(0, 400)}`);
      process.stdout.write(JSON.stringify({ ok: true, bvid: r.bvid, aid: r.aid, parts }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
      process.exitCode = 1;
    }
  });

// ─── _live-pump:边录边传 PoC(T-63 阶段 2)─────────────────────────────────────
// 一段直播 → ffmpeg(-fs 上界) → UPOS 分块 → 建私稿。与生产的区别:
//  · 封口信号是 **ffmpeg 进程退出**,不是「出现后继段」→ P1 不必等 P2;
//  · spool 文件始终写,失败/取消时按实际长度回退 biliup 文件上传。
// ⚠️ 真实投稿:调用即建稿件(B 站无删稿 API)。不接生产路径,须显式确认。
program
  .command("_live-pump <room>", { hidden: true })
  .description("[内部] 直播间边录边传 PoC:ffmpeg -fs 分段 → UPOS 直传 → 建私稿")
  .requiredOption("--cookies <path>", "biliup cookies.json 路径")
  // 默认上界从常量派生,不写裸数字:隐私闸门会把看似房间号的长数字当违规(实测误报)。
  .option("--size <bytes>", `分段字节上界(默认 ${DEFAULT_SEGMENT_CAP} = 对齐后的 1GiB;须 10MiB 对齐)`, String(DEFAULT_SEGMENT_CAP))
  .option("--segments <n>", "最多录几段(默认 1;调试用)", "1")
  .option("--max-sec <sec>", "时长阈值(秒):与 --size 谁先到算一 P。0/缺省 = 只用字节兜底")
  .option("--spool-dir <dir>", "spool 目录(默认系统临时目录)")
  .option("--title <title>", "稿件标题(默认 测试-<timestamp>)")
  .option("--tid <tid>", "投稿分区(默认 21 生活-日常)", "21")
  .option("--tag <tag>", "标签(逗号分隔)", "测试")
  .option("--line <line>", "上传线路(默认 txa)", "txa")
  .option("--private", "仅自己可见(默认)", true)
  .option("--submit", "真的建稿(缺省只跑一段到 complete,不建稿)")
  .action(async (room: string, o: {
    cookies: string; size: string; segments: string; maxSec?: string; spoolDir?: string;
    title?: string; tid: string; tag: string; line: string; private: boolean; submit?: boolean;
  }) => {
    const { platformForRoom } = await import("@drec/core");
    const { alignFileSize, DEFAULT_SEGMENT_CAP, runLivePump } = await import("@drec/zero-upload");
    const { tmpdir } = await import("node:os");

    const platform = platformForRoom(room);
    const sizeCap = alignFileSize(Number(o.size));
    if (sizeCap !== Number(o.size)) {
      process.stderr.write(`[live-pump] size ${o.size} 未按 10MiB 对齐 → 用 ${sizeCap}\n`);
    }
    if (sizeCap !== DEFAULT_SEGMENT_CAP && o.size === String(DEFAULT_SEGMENT_CAP)) {
      // 走到这里说明用户手改过 --size;提示真实生效值,避免「我设了 1GiB 怎么变成 1030MiB」。
      process.stderr.write(`[live-pump] 默认上界已按 10MiB 对齐为 ${DEFAULT_SEGMENT_CAP}(1GiB=102.4×10MiB,不对齐)\n`);
    }
    const spoolDir = o.spoolDir ?? `${tmpdir()}/live-pump`;
    const maxSegments = Math.max(1, Number(o.segments));
    const title = o.title ?? `测试-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
    const res = await runLivePump({
      cookiesPath: o.cookies,
      room,
      fetch: async (r, q) => {
        const s = await platform.getStream(r, q);
        return {
          living: s.living,
          ...(s.url ? { url: s.url } : {}),
          ...(s.headers ? { headers: s.headers } : {}),
        };
      },
      quality: platform.defaultQuality ?? "origin",
      spoolDir,
      title,
      tid: Number(o.tid),
      tag: o.tag,
      private: o.private !== false,
      sizeCap,
      maxMs: o.maxSec && Number(o.maxSec) > 0 ? Number(o.maxSec) * 1000 : undefined,
      maxSegments,
      line: o.line,
      submit: o.submit === true,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    const out: Record<string, unknown> = {
      ok: res.ok, room, sizeCap,
      segments: res.segments, spoolDir: res.spoolDir,
      submitted: !!res.bvid, bvid: res.bvid, aid: res.aid,
      title: res.title, parts: res.segments.length,
      ...(res.error ? { error: res.error } : {}),
      ...(res.archiveExists ? { archiveExists: true } : {}),
    };
    process.stderr.write(`[live-pump] 状态保留在 ${res.statePath}(确认过的 spool 已清理)\n`);
    process.stdout.write(JSON.stringify(out) + "\n");
    if (!res.ok) process.exitCode = 1;
  });

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
  .option("--merge-sessions", "把目录内全部会话按时间序拼成一片(断流重连合并用)")
  .option("--keep-time", "输出保留会话时间戳 {base}.mp4（默认剥成 {主播}_{日期}.mp4）")
  .option("--out-base <name>", "输出 stem(覆盖默认剥日期 / --keep-time;hub 标题模板用)")
  .option("--format <fmt>", "输出容器 mp4|mkv(缺省 mp4;original 按 mp4)")
  .action(async (o: { in: string; base?: string; keepTime?: boolean; mergeSessions?: boolean; outBase?: string; format?: string }) => {
    const notifier = toggledNotifier(webhookOf());
    try {
      // 容器唯一判定 = core effectiveStageFormat(合并后只落存档,无投稿语境);非法值抛错 → 非 0 退出,不静默回落。
      const ext = stageExt(effectiveStageFormat(parseOutputFormat(o.format), "stage"));
      const groups = groupSessionsInDir(o.in);
      const bases = o.base ? [o.base] : Object.keys(groups);
      if (o.mergeSessions) {
        // 断流重连 = 同一场:全部会话按时间序无损拼成一片,弹幕按累计视频时长偏移合并。
        const ordered = Object.keys(groups).sort();
        const inputs = ordered.map((b) => ({
          tsFiles: groups[b].ts.map((f) => join(o.in, f)),
          xmlPath: groups[b].xml ? join(o.in, groups[b].xml) : undefined,
        }));
        const outBase = (o.outBase ?? "").trim() || (ordered[0] ? dateNameOf(ordered[0]) : "");
        if (!outBase) { console.error("[merge] --merge-sessions 目录内无会话"); process.exitCode = 2; return; }
        const outMp4 = join(o.in, `${outBase}${ext}`);
        const outXml = join(o.in, `${outBase}.xml`);
        const segFiles = ordered.flatMap((b) => groups[b].ts.map((f) => join(o.in, f)));
        console.log(`[merge] ${ordered.join(" + ")} → ${basename(outMp4)}`);
        await scanSegmentsIntegrity(segFiles);
        await mergeSessions(inputs, outMp4, outXml);
        console.log(`[merge] 完成: ${outMp4}`);
        await scanOutputTailIntegrity(outMp4);
        await notifier.notify({ kind: "mergeDone", file: outMp4 });
        return;
      }
      // 会话 base = {主播}_{YYYY-MM-DD}_{HH-MM-SS};上传约定用 {主播}_{YYYY-MM-DD}。
      // 同日多会话(断流多场)会撞名 → 撞的保留完整 base(带时间戳),不撞的剥成 {主播}_{日期}。
      const dateName = dateNameOf;
      const clash: Record<string, number> = {};
      for (const b of bases) clash[dateName(b)] = (clash[dateName(b)] ?? 0) + 1;
      for (const b of bases) {
        const g = groups[b];
        if (!g || g.ts.length === 0) { console.error(`[merge] 跳过 ${b}：无分段`); continue; }
        const outBase = (o.outBase ?? "").trim() || (o.keepTime || clash[dateName(b)] > 1 ? b : dateName(b));
        const out = join(o.in, `${outBase}${ext}`);
        const segFiles = g.ts.map((f) => join(o.in, f));
        console.log(`[merge] ${b}: ${g.ts.length} 段 → ${basename(out)}`);
        await scanSegmentsIntegrity(segFiles);
        await mergeSession(segFiles, out);
        console.log(`[merge] 完成: ${out}`);
        await scanOutputTailIntegrity(out);
        await notifier.notify({ kind: "mergeDone", file: out });
      }
    } catch (e) {
      await toggledNotifier(webhookOf()).notify({ kind: "error", stage: "merge", message: (e as Error).message });
      throw e;
    }
  });

function dateNameOf(base: string): string {
  return base.replace(/_\d{2}-\d{2}-\d{2}$/, "");
}

/**
 * 合并前体检（只读解码扫描，不改码流；见 @drec/post-process integrity）：
 * **只整段扫末段** —— 主播硬切断流/进程被强杀的残帧都集中在末段，也是唯一会导致明显花屏的位置。
 * 曾经用 `-sseof` 扫其余段的尾部，但 TS 无索引、跳过去必落在非关键帧，会刷出
 * `co located POCs unavailable` / `Missing reference picture` 之类的伪影（实测成品全片 0 条），故废弃。
 */
async function scanSegmentsIntegrity(tsFiles: string[]): Promise<void> {
  const { scanMediaErrors, formatScanLine } = await import("@drec/post-process");
  const last = tsFiles[tsFiles.length - 1];
  if (!last) return;
  const res = await scanMediaErrors(last);
  console.log(formatScanLine(`末段 ${basename(last)}`, res));
}

/**
 * 合并后成品尾部体检（只读）：`-c copy` 无损,前段干净不代表尾部干净,这里确认末段损坏有没有被带进成品。
 * 两个体检都打印 `[integrity] ✓/⚠` 行,⚠ 表示可能花屏 —— hub 管线会解析并告警,由人决定删稿重录。
 */
async function scanOutputTailIntegrity(outMp4: string): Promise<void> {
  const { scanMediaErrors, formatScanLine, formatOutputVerdict } = await import("@drec/post-process");
  const res = await scanMediaErrors(outMp4, { lastSeconds: 60 });
  console.log(formatScanLine("成品尾部 60s", res));
  const verdict = formatOutputVerdict(res);
  if (verdict) console.log(verdict);
}

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
  .option("--video-codec <c>", "视频编码器: libx264(默认)|libx265|h264_videotoolbox(硬编,忽略 crf)")
  .option("--crf <n>", "软编质量(仅 x264/x265),越小越清晰", (v) => Number(v))
  .option("--preset <p>", "软编预设(仅 x264/x265): veryfast(默认)|fast|medium…")
  .option("--video-bitrate <r>", "码率上限如 8M(软编→VBV 约束控大小;硬编→目标 -b:v)")
  .action(async (o: { video?: string; xml?: string; indir?: string; base?: string; style: string; giftValue: string; out?: string; hwaccel: string; videoCodec?: string; crf?: number; preset?: string; videoBitrate?: string }) => {
    if (o.style !== "danmu" && o.style !== "livechat") {
      console.error("[burn] --style 仅支持 danmu | livechat"); process.exit(2); return;
    }
    try {
      let ass: string, label: string, video: string;

      if (o.indir && o.base) {
        // ── 多段模式：每段 xml 按前序 .ts 累计时长平移 → 合并到一条时间轴 ──
        const { renderSegmentsToAss } = await import("@drec/post-process");
        const groups = groupSessionsInDir(o.indir);
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

      // 默认输出 = {video stem}_{style}{video 扩展名}:烧录产物与 plain 同容器(mp4 → _danmu.mp4;mkv → _danmu.mkv)。
      const out = o.out ?? resolve(video).replace(/(\.[^./\\]+)$/, `_${o.style}$1`);
      console.log(`[burn] ${basename(video)} + ${label} → ${basename(out)}`);
      await burn({ inputMp4: video, assText: ass, outMp4: out, fontsDir: FONTS_DIR, hwaccel: o.hwaccel as "auto",
        videoCodec: o.videoCodec, crf: o.crf, preset: o.preset, videoBitrate: o.videoBitrate });
      console.log(`[burn] 完成: ${out}`);
      await toggledNotifier(webhookOf()).notify({ kind: "burnDone", style: o.style, file: out });
    } catch (e) {
      await toggledNotifier(webhookOf()).notify({ kind: "error", stage: "burn", message: (e as Error).message });
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
      await toggledNotifier(webhookOf()).notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
    } catch (e) {
      await toggledNotifier(webhookOf()).notify({ kind: "error", stage: "upload", message: (e as Error).message });
      throw e;
    }
  });

// ─── Hub starter: 多节点同步编排（cli L5 注入到 app L4，避免循环依赖）──────────────
// app 不直接依赖 @drec/orchestrator（orchestrator 依赖 app），由 cli 作为 L5 入口注入。
// web API 在 hub 规则/worker 变更后立即触发一次任务同步(不等 60s 周期 tick)。
let hubSyncTasks: ((opts?: { force?: boolean }) => Promise<void>) | undefined;

const hubSyncGate = new SyncGate();
const requestHubSync = (opts?: { force?: boolean }): void => {
  // 返回 true = 现在就跑一轮(force 由 beginRun 消费);false = 已合并进补跑 / 等就绪。
  if (hubSyncGate.request(opts?.force)) void hubSyncTasks!({ force: hubSyncGate.beginRun() });
};

let hubRetryNode:
  | ((streamKey: string, node: WorkflowNodeKey, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>)
  | undefined;
let hubStopJob:
  | ((streamKey: string) => Promise<{ ok: boolean; error?: string; code?: number }>)
  | undefined;
let hubRunNow:
  | ((opts: { streamKey: string; winnerWorker?: string; wait?: boolean; force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string; forceable?: boolean }>)
  | undefined;
let hubRecordingSnapshot = new Map<string, RecordingWorkerStatusDTO[]>();
/** 各节点边录边传的实时进度(F1;随 5 秒状态轮询整体替换,只读展示)。 */
let hubDeliverySnapshot: RollingDeliveryDTO[] = [];
/** probeAllWorkers 的结果缓存 TTL。 */
const PROBE_CACHE_MS = 30_000;
const readRollingDelivery = (): RollingDeliveryDTO[] => hubDeliverySnapshot;
const recordingSnapshotKey = (platform: string, roomSlug: string): string => `${platform}:${roomSlug}`;
const readRecordingWorkers = (platform: string, roomSlug: string): RecordingWorkerStatusDTO[] =>
  hubRecordingSnapshot.get(recordingSnapshotKey(platform, roomSlug)) ?? [];
/** master 资源池快照提供者(由 hubStarter.start 注入,读同一 ResourcePool 实例);未启动 → undefined。 */
let hubPoolSnapshot: (() => HubPoolSnapshotDTO) | undefined;
const readPoolSnapshot = (): HubPoolSnapshotDTO | undefined => hubPoolSnapshot?.();
/**
 * Master-side sync receipt settings (expected version / last sync error).
 * Hub start injects the live TaskStore; undefined until hub starts.
 */
let hubReceiptSettings: Pick<TaskStore, "getSetting" | "setSetting"> | undefined;
/** web API → hubStarter.retryNode 的统一入口(hub 未启动 → 400)。 */
const requestHubRetryNode = async (
  streamKey: string,
  node: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; code?: number }> => {
  if (!hubRetryNode) return { ok: false, error: "hub 未启动", code: 400 };
  return hubRetryNode(streamKey, node as WorkflowNodeKey, opts);
};
const requestHubStopJob = async (
  streamKey: string,
): Promise<{ ok: boolean; error?: string; code?: number }> => {
  if (!hubStopJob) return { ok: false, error: "hub 未启动", code: 400 };
  return hubStopJob(streamKey);
};
/**
 * web API → 节点日志代查的统一入口(F3)。
 *
 * 每次现读 hub.config.json 找 worker(与 probeAllWorkers 同源)→ 建 scoped transport → 读日志。
 * **刻意不缓存结果**:日志就是要看最新的;一次点击一条 ssh,代价可接受。
 *
 * 本机(local)worker 直接回提示:它的日志就在 master 自己的任务详情页,F3 要解决的是
 * 「远端节点要登机器看网页」,本机代查没有意义。
 */
const requestNodeTaskLogs = async (workerId: string, taskId: number, lines: number): Promise<NodeTaskLogsDTO> => {
  const { SshTransport } = await import("@drec/orchestrator");
  const { workerStore, rootHubConfig } = await import("@drec/app");
  const w = workerStore.listWorkers(rootHubConfig()).find((x) => x.id === workerId);
  if (!w) return { workerId, taskId, lines: [], error: `未配置的 worker id: ${workerId}` };
  if (w.kind === "local") return { workerId, taskId, lines: [], error: "本机节点:日志就在 master 的任务详情页" };
  const t = new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot! });
  try {
    const r = await t.taskLogs(taskId, lines);
    return { workerId, taskId, lines: r.lines, ...(r.error ? { error: r.error } : {}) };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    // 旧 bundle 没有该隐藏命令 → 说清楚是「节点版本旧」,别让用户以为是网络问题。
    const unsupported = /unknown command|未知命令/i.test(msg);
    return { workerId, taskId, lines: [], error: unsupported ? "节点 bundle 过旧,不支持日志代查(需升级节点)" : msg };
  }
};

/** web API → 读某节点的任务清单(F3)。与日志代查同一取舍:现读配置、不缓存。 */
const requestNodeTasks = async (workerId: string): Promise<NodeTasksDTO> => {
  const { SshTransport } = await import("@drec/orchestrator");
  const { workerStore, rootHubConfig } = await import("@drec/app");
  const w = workerStore.listWorkers(rootHubConfig()).find((x) => x.id === workerId);
  if (!w) return { workerId, tasks: [], error: `未配置的 worker id: ${workerId}` };
  if (w.kind === "local") return { workerId, tasks: [], error: "本机节点:日志就在 master 的任务详情页" };
  const t = new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot! });
  try {
    const r = await t.listTasks();
    return { workerId, tasks: r.tasks };
  } catch (e) {
    return { workerId, tasks: [], error: (e as Error)?.message ?? String(e) };
  }
};

const requestHubRunNow = async (
  opts: { streamKey: string; winnerWorker?: string; wait?: boolean; force?: boolean },
): Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string; forceable?: boolean }> => {
  if (!hubRunNow) return { ok: false, error: "hub 未启动", code: 400 };
  return hubRunNow(opts);
};

const hubStarter: HubStarter = {
  requestSyncTasks: requestHubSync,
  recordingWorkers: readRecordingWorkers,
  nodeTaskLogs: requestNodeTaskLogs,
  nodeTasks: requestNodeTasks,
  rollingDelivery: readRollingDelivery,
  poolSnapshot: readPoolSnapshot,
  retryNode: requestHubRetryNode,
  stopJob: requestHubStopJob,
  runNow: requestHubRunNow,
  async start(opts) {
    hubReceiptSettings = opts.store;
    const {
      registerBuiltinTransports, Reconciler, SyncLedger, startHub, getTransport, recordingStatusWorkerIds,
      satisfiesCapabilities,
      buildWorkflow, runWorkflowNodes, deriveStageProducts, withOutputStem, ResourcePool, openUploadLimitStore,
      parseNodeUploadConfig } = await import("@drec/orchestrator");
    const { ffprobeVideo } = await import("@drec/post-process");
    const { handleEnqueue, handleProcStatus, handleProcCancel } = await import("@drec/app");
    const { statSync } = await import("node:fs");
    const { uploadPlain, appendGroup, countVideoParts, hubStore, workerStore, rootHubDir, rootHubConfig, rootConfigDir, rootStageDir, drecRoot, listNodeTasks, applyRemoteTasks, resolveTaskStreamCookies } = await import("@drec/app");
    const { FileLogger } = await import("@drec/observability");
    const { recordExpectedVersion, recordSyncError } = await import("@drec/app");

    const hubCfg = JSON.parse(opts.hubConfigJson ?? "null") as null | {
      platform?: string;
      workers?: Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }>;
      /** 旧字段名(迁移兼容,读时 `workers ?? tenants`)。 */
      tenants?: Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string }>;
      settleMs?: number;
      pollMs?: number;
      reconcileIntervalMs?: number;
      /** hub 任务同步周期(ms);缺省 60_000。 */
      syncIntervalMs?: number;
      stageDir?: string;
      cookies?: string;
      cleanMaxGapSec?: number;
      /** 断流重连合并窗(ms);缺省 10 分钟。 */
      reconnectWindowMs?: number;
      /** 上传确认后旁路校验(回读分 P 数)的延迟(ms);缺省 10 分钟。只记录/告警,不影响清理(issue #92)。 */
      sideCheckDelayMs?: number;
      /** 投稿默认(per-task 文件留空时回退);旧字段 uploadMeta 也认(迁移兼容)。 */
      uploadDefaults?: { tag?: string; tid?: number; desc?: string; titleTemplate?: string; submissionTitleTemplate?: string; partTitleTemplate?: string };
      uploadMeta?: { tag?: string; tid?: number; desc?: string; titleTemplate?: string; submissionTitleTemplate?: string; partTitleTemplate?: string };
      /** Max settle wait before reconciler proceeds regardless (seconds). */
      maxWaitSec?: number;
      /** Settle poll interval (seconds). */
      settleSec?: number;
      /** 资源池 / 崩溃恢复安全阀。缺省:cpu/net 各 1、内存闸门 2048MB/600s、stale 600s。 */
      resources?: {
        maxCpuParallel?: number;
        maxNetParallel?: number;
        minBurnFreeMemMB?: number;
        memWaitTimeoutMs?: number;
        staleMs?: number;
        /** T7:跨房间的调度并发上限(同时派发几场后处理流程)。缺省 2;与 maxCpuParallel 无关。 */
        maxConcurrentPipelines?: number;
        /** 磁盘看门狗阈值(GB):节点数据根剩余低于此值 → master 告警。缺省 10,0=关。 */
        diskMinGB?: number;
        /** 全局上传队列:B 站按提交次数限流(601)。窗口内最多 uploadRateLimit 次,命中后冷却 uploadCooldownMs。 */
        uploadRateLimit?: number;
        uploadRateWindowMs?: number;
        uploadCooldownMs?: number;
      };
    };
    if (!hubCfg) {
      opts.warn("[hub] --hub 已设置但 --hub-config / settings.hubConfig 未提供，跳过");
      return undefined;
    }

    const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
      const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
      const endMs = statSync(file).mtimeMs;
      return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
    };

    // BUG#2 fix: taskRooms getter — maps both anchorName AND task.name → roomSlug so
    // local node recordings cluster with remote (ssh) nodes that report the numeric roomSlug.
    const buildTaskRooms = (): Record<string, string> => {
      const map: Record<string, string> = {};
      for (const task of opts.store.listTasks()) {
        const slug = platformForRoom(task.room).extractRoomSlug(task.room);
        if (task.name) map[task.name] = slug;
        if (task.anchorName) map[task.anchorName] = slug;
      }
      return map;
    };
    // 某 roomSlug 是否还在本机录制(local transport settle 用):匹配该 slug 的任务有在录的就算「未收播」,
    // 防周期对账在录制中途就合并残片(settle 等录完才处理)。
    const isRoomRecording = (slug: string): boolean =>
      opts.store.listTasks().some(
        (t) => platformForRoom(t.room).extractRoomSlug(t.room) === slug && opts.manager.isRecording(t.id),
      );
    registerBuiltinTransports({
      ffprobe,
      taskRooms: buildTaskRooms,
      isRoomRecording,
      activeRecordingRooms: () => opts.store.listTasks().flatMap((t) => {
        if (!opts.manager.isRecording(t.id)) return [];
        const platform = platformForRoom(t.room);
        return [{ platform: platform.id, roomSlug: platform.extractRoomSlug(t.room) }];
      }),
      // local worker = master 自身:hub 任务同步直接落在本机 store(与远端 `_tasks` / `_apply-tasks` 同路径)。
      listTasks: () => listNodeTasks(opts.store),
      // 处理任务表通道(T9a):local worker 与远端 `_enqueue` / `_proc-status` 同一执行体(无派发方,仅可被调用)。
      procChannel: {
        enqueue: (dataRoot, req) => handleEnqueue(dataRoot, req, { capabilities: listProcessors().map((p) => p.kind) }),
        procStatus: (dataRoot, ids) => handleProcStatus(dataRoot, ids),
        procCancel: (dataRoot, ids) => handleProcCancel(dataRoot, ids),
      },
      // adopt=false:本机源任务保持用户可编辑(managedBy 不置 hub),只有远端节点的同步任务才锁编辑。
      applyTasks: (input) => applyRemoteTasks(opts.store, input.desired, opts.log, {
        adopt: false,
        force: input.force === true,
        // 审计快照落 <数据根>/config/managed/(显式传目录,不从 DOUYIN_REC_ROOT 推导)。
        managedStateDir: join(rootConfigDir(), "managed"),
        // T16:本机 worker 也必须记录期望版本,否则状态页只报 unknown。
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      }),
    });

    const workers = hubCfg.workers ?? hubCfg.tenants ?? [];
    // loadWorkers 现读 hub.config.json(现读不缓存→UI/手改即时生效)。首启无文件时回落 --hub-config 里的 workers。
    const loadWorkers = (): Array<{ id: string; kind: string; host?: string; dataRoot?: string; name?: string; capabilities?: string[] }> => {
      const fromFile = workerStore.listWorkers(rootHubConfig());
      return fromFile.length ? fromFile : workers;
    };
    let refreshingRecordingStatus = false;
    /** 状态探测与 pipeline 共用同一批 transport 实例(避免每 5s 重建 SshTransport)。 */
    let statusTransports: Map<string, ReturnType<typeof getTransport>> | null = null;
    let statusTransportsFingerprint = "";
    const refreshRecordingStatus = async (): Promise<void> => {
      if (refreshingRecordingStatus) return;
      refreshingRecordingStatus = true;
      try {
        const configuredWorkers = loadWorkers();
        // 只查询「至少被一条绑定源任务的规则选中」的 worker;未被任何规则选中的 worker
        // 没有房间需要展示状态,每 5s 对其发 SSH 纯属浪费。
        const boundWorkerIds = recordingStatusWorkerIds(
          hubStore.listHubRules(rootHubDir()),
          configuredWorkers.map((w) => w.id),
        );
        // worker 配置可能刚被改(增删/换 kind)→ 指纹变了就重建,否则复用。
        const fingerprint = configuredWorkers.map((w) => `${w.id}:${w.kind}:${w.host ?? ""}:${w.dataRoot ?? ""}`).join("|");
        if (!statusTransports || statusTransportsFingerprint !== fingerprint) {
          statusTransports = buildTransports();
          statusTransportsFingerprint = fingerprint;
        }
        const probed = configuredWorkers.filter((w) => boundWorkerIds.has(w.id));
        const results = await Promise.all(probed.map(async (worker) => {
          try {
            const transport = statusTransports!.get(worker.id);
            if (!transport) throw new Error(`未注册的 worker transport: ${worker.id}`);
            if (!transport.activeRecordingRooms) throw new Error("worker 不支持录制状态查询");
            const st = transport.recordingStatus
              ? await transport.recordingStatus()
              : { rooms: await transport.activeRecordingRooms(), rolling: [] };
            return { worker, rooms: st.rooms, rolling: st.rolling, error: null };
          } catch (e) {
            return { worker, rooms: [], rolling: [], error: (e as Error).message };
          }
        }));
        const byWorker = new Map(results.map((r) => [r.worker.id, r]));
        // 本轮探测的完成时刻:整轮共用一个值(不是每行各自 now()),否则同一批行的
        // checkedAt 会差几毫秒,UI 上「N 秒前核对」会显示得参差不齐。
        const checkedAt = Date.now();
        const next = new Map<string, RecordingWorkerStatusDTO[]>();
        for (const rule of hubStore.listHubRules(rootHubDir())) {
          const sourceId = rule.recording?.sourceTaskId;
          if (sourceId == null) continue;
          const source = opts.store.getTask(sourceId);
          if (!source) continue;
          const platform = platformForRoom(source.room);
          const roomSlug = platform.extractRoomSlug(source.room);
          if (roomSlug !== rule.roomSlug || platform.id !== rule.platform) continue;
          const selectedIds = rule.workers?.length
            ? rule.workers
            : configuredWorkers.map((worker) => worker.id);
          const rows = selectedIds.flatMap((workerId) => {
            const result = byWorker.get(workerId);
            if (!result) return [];
            return [{
              workerId,
              workerName: result.worker.name ?? workerId,
              state: result.error
                ? "unavailable" as const
                : result.rooms.some((room) => room.platform === platform.id && room.roomSlug === roomSlug)
                  ? "recording" as const
                  : "not_recording" as const,
              checkedAt,
            }];
          });
          // 「房间是否要展示状态」与「当前是否已探到该房间」是独立维度：
          // 一条规则先探到、后被改成未探到（或源任务删除）时，若直接覆盖会留下陈旧状态。
          // 因此先清空该房间的旧条目,再写入本次结果。
          const key = recordingSnapshotKey(platform.id, roomSlug);
          next.set(key, rows);
        }
        // `next` 每次从空 Map 重建,天然丢掉「源任务已删除/解绑」的房间,
        // 不需要也不能在遍历 hubRecordingSnapshot 时删它(会边迭代边改)。
        hubRecordingSnapshot = next;
        // F1:边录边传进度。节点探测失败 → 该节点的进度整体丢弃(不展示陈旧数字冒充实时)。
        hubDeliverySnapshot = results.flatMap((r) => r.error ? [] : r.rolling.map((s): RollingDeliveryDTO => ({
          workerId: r.worker.id,
          workerName: r.worker.name ?? r.worker.id,
          platform: s.platform, roomSlug: s.roomSlug, anchorName: null,
          sessionBase: s.sessionBase, bv: s.bv ?? null,
          confirmed: s.confirmed, total: s.total, ambiguous: s.ambiguous,
          uploading: s.uploading ?? null, recording: s.recording, checkedAt,
          ...(s.lockedBytes !== undefined ? { lockedBytes: s.lockedBytes } : {}),
        })));
      } catch (e) {
        opts.warn(`[hub] 刷新 worker 录制状态失败: ${(e as Error).message}`);
      } finally {
        refreshingRecordingStatus = false;
      }
    };
    const buildTransports = (): Map<string, ReturnType<typeof getTransport>> =>
      new Map(loadWorkers().map((w) => [w.id, getTransport(w)]));
    const transports = buildTransports();     // 初始 Map(pipelineDeps 也用它)
    const dbPath = (opts.dbPath ?? "douyin-rec.db").replace(/\.db$/, "-sync.db");
    const ledger = new SyncLedger(dbPath);

    // 投稿默认:uploadDefaults(新)> uploadMeta(旧,迁移兼容)> 硬兜底。
    const uploadDefaults = hubCfg.uploadDefaults ?? hubCfg.uploadMeta ?? {};
    // 磁盘水位(GB)统一口径(core resolveDiskMinGB):上传闸门 / reconciler 看门狗共用同一解析结果,非数字回落 10 并告警一次。
    const diskMinGB = resolveDiskMinGB(hubCfg.resources?.diskMinGB, (m) => console.warn(m)).gb;
    const defaultTag = uploadDefaults.tag ?? "直播,录像";
    const defaultTid = uploadDefaults.tid ?? 21;

    const { spawn } = await import("node:child_process");
    // T15:并行度/内存门槛**每轮热读**(UI 改完立即生效,无需重启)。
    // 读的是「当前真正生效的那份来源」(arg-file / settings / root-file 每次现解析),
    // 而不是构造时读一次的 hubCfg 快照 —— 否则 UI 改的是另一份文件,或改了要等重启。
    //
    // 上传限流三项**故意不给 live getter**:它们由 T8/T19 的持久化账本 + UploadGate 实时判定,
    // 热读配置反而会在改配置时**清掉已积累的窗口**,等于「每次改配置都重新放行一次」,
    // 正是 601 最怕的。构造值只作为冷启动基线。
    const liveResources = (): HubResources => {
      try {
        const resolved = resolveHubConfig(opts.hubConfigArg, opts.store);
        const cfg = resolved.json ? (JSON.parse(resolved.json) as { resources?: Partial<HubResources> }) : null;
        const r = cfg?.resources ?? {};
        return {
          maxCpuParallel: r.maxCpuParallel ?? hubCfg.resources?.maxCpuParallel ?? 1,
          maxNetParallel: r.maxNetParallel ?? hubCfg.resources?.maxNetParallel ?? 1,
          minBurnFreeMemMB: r.minBurnFreeMemMB ?? hubCfg.resources?.minBurnFreeMemMB ?? 2048,
          maxConcurrentPipelines: r.maxConcurrentPipelines ?? hubCfg.resources?.maxConcurrentPipelines ?? 2,
        };
      } catch {
        // 配置在两次读取之间被改坏(JSON 解析失败)→ 沿用构造值,不能因为手滑就把闸门打不开。
        return {
          maxCpuParallel: hubCfg.resources?.maxCpuParallel ?? 1,
          maxNetParallel: hubCfg.resources?.maxNetParallel ?? 1,
          minBurnFreeMemMB: hubCfg.resources?.minBurnFreeMemMB ?? 2048,
          maxConcurrentPipelines: hubCfg.resources?.maxConcurrentPipelines ?? 2,
        };
      }
    };
    const pool = new ResourcePool({
      maxCpuParallel: hubCfg.resources?.maxCpuParallel ?? 1,
      maxNetParallel: hubCfg.resources?.maxNetParallel ?? 1,
      minBurnFreeMemMB: hubCfg.resources?.minBurnFreeMemMB ?? 2048,
      maxCpuParallelLive: () => liveResources().maxCpuParallel ?? 1,
      maxNetParallelLive: () => liveResources().maxNetParallel ?? 1,
      minBurnFreeMemMBLive: () => liveResources().minBurnFreeMemMB ?? 2048,
      memWaitTimeoutMs: hubCfg.resources?.memWaitTimeoutMs ?? 600_000,
      uploadRateLimit: hubCfg.resources?.uploadRateLimit ?? 5,
      uploadRateWindowMs: hubCfg.resources?.uploadRateWindowMs ?? 600_000,
      uploadCooldownMs: hubCfg.resources?.uploadCooldownMs ?? 1_800_000,
    }, {
      // T8:冷却/滑动窗口跨重启保留(同 sync 库 upload_limits 表)。
      // 复用 ledger 的 dbPath —— 两边同一文件,不额外造库;pool 只借用,不拥有生命周期。
      // T19:分键 = `bilibili:<DedeUserID>`(从本机 biliup cookies 解析)→ 节点侧上传用同一个键,
      // master 与节点的同账号冷却/窗口互相生效(键算法唯一真理 = core/upload-gate.ts)。
      limitStore: openUploadLimitStore(dbPath, { log: opts.warn }),
      limitKey: masterUploadAccountKey(opts.warn),
      warn: opts.warn,
    });
    // plan 038: queue-managed upload settings; absent/invalid = safe defaults (blocking, nothing polled).
    const nodeUploadCfg = parseNodeUploadConfig((hubCfg as { nodeUpload?: unknown }).nodeUpload);
    const pipelineDeps = {
      transports,
      ledger,
      pool,
      nodeUpload: nodeUploadCfg,
      // 返回 stdout+stderr(各截尾 64KB,biliup 输出可达 MB 级)→ pipeline 摘尾写进该场 job.log。
      sh: (cmd: string) => new Promise<string>((res, rej) => {
        // detached 进程组:停任务时 kill(-pid) 能带走 ffmpeg 孙进程;其它 spawn 不建组。
        const p = spawn("sh", ["-c", cmd], { detached: true });
        registerChild(p, { processGroup: true });
        const tail = (s: string): string => (s.length > 65536 ? s.slice(-65536) : s);
        let stdout = "", stderr = "";
        p.stdout?.on("data", (b) => { stdout = tail(stdout + String(b)); });
        p.stderr?.on("data", (b) => { stderr = tail(stderr + String(b)); });
        p.on("error", rej);
        p.on("close", (code) => {
          try { throwIfAborted(); } catch (e) { rej(e); return; }
          if (code !== 0) rej(new Error(`sh rc=${code}\n${stderr}`));
          else res(`${stdout}\n${stderr}`);
        });
      }),
      // 穿插上传接缝:pipeline 先 fire uploadPlain(网络)与烧录并行,再 await BV 后串行 appendGroup。
      uploadPlain: (plain: UploadOpts) => uploadPlain({ plain }),
      appendGroup: (o: { bv: string; files: string[]; cookies: string; public: boolean }) =>
        // countParts 让 append 具备幂等判定:失败后查分 P 数,变多=实际已成功、查不到=转人工不重试。
        appendGroup({
          cookies: o.cookies,
          bv: o.bv,
          files: o.files,
          public: o.public,
          countParts: () => countVideoParts(o.bv, o.cookies),
        }),
      // T11 核验接缝:取该稿件在 B站的**实际分 P 数**。核验的期望值来自上传时写下的
      // sync_parts 检查点(实际提交了几段),不用「文件大小上界」—— 那是评审明确否决的做法。
      // 缺省不注入 = 不做旁路校验;这里注入 = 上传确认后延迟回读分 P 数,**只记录/告警,不影响清理**(issue #92)。
      // cookies 用 hubCfg.cookies(与 appendGroup 同源;per-job override 已在 pipeline 内传下去)。
      countParts: (bv: string) => countVideoParts(bv, hubCfg.cookies ?? ""),
      // 旁路校验延迟(issue #92):上传确认后多久回读分 P 数;只记录/告警,不影响清理。缺省 10 分钟。
      sideCheckDelayMs: hubCfg.sideCheckDelayMs,
      notify: opts.onEvent,
      // 收尾后留存转格式(plans/036 T9b):stage 源段副本派到本机处理任务表(master 数据根,与 `_enqueue` 同一执行体)。
      finalizeFormat: {
        stageProc: {
          enqueue: (req: EnqueueRequest) => handleEnqueue(drecRoot(), req),
          procStatus: (ids: string[]) => handleProcStatus(drecRoot(), ids),
        },
      },
      // job.log 的落盘实现由组合根装配:observability 的 FileLogger,路径 = <stage>/<sanitized streamKey>/job.log
      //(目录名 = core 的 sanitizeStreamKey,与 pipeline/hub-jobs 同一真理源)。orchestrator 只调 ScopedLogger 接口。
      makeRunLogger: (streamKey: string) =>
        new FileLogger(`${hubCfg.stageDir ?? rootStageDir()}/${sanitizeStreamKey(streamKey)}/job.log`),
      cfg: {
        cleanMaxGapSec: hubCfg.cleanMaxGapSec ?? 30,
        // 磁盘水位闸门(issue #8):与下面的 Reconciler 看门狗**同源同解析**(core resolveDiskMinGB)。
        diskMinGB,
        stageDir: hubCfg.stageDir ?? rootStageDir(),
        cookies: hubCfg.cookies ?? "",
        uploadMode: "stage" as const, // 全局兜底 = 不自动传;每任务文件按需 mode:"upload"
        uploadPrivate: true,
        uploadMeta: {
          tag: defaultTag, tid: defaultTid, desc: uploadDefaults.desc,
          titleTemplate: uploadDefaults.titleTemplate,
          submissionTitleTemplate: uploadDefaults.submissionTitleTemplate,
          partTitleTemplate: uploadDefaults.partTitleTemplate,
        },
        timeZone: effectiveTimezone(opts.store),
      },
    };

    // 每房间 hub 任务配置来自文件 <root>/config/hub/{platform}.{roomSlug}.json(现读不缓存→手改/UI 即时生效)。
    // hub = 全局管理器:只处理「有 enabled 任务文件」的房间;无文件/禁用 → 返 null 跳过该房间。
    // 录制任务只管录;某房间产哪些、清不清理、传不传,全看它的 hub 任务文件。upload 留空回退全局默认。
    const hubDir = rootHubDir();
    const resolveCfg = (platform: string, slug: string): PipelineCfg | null => {
      const rule = hubStore.getHubRule(hubDir, hubStore.hubKey(platform, slug));
      if (!rule || !rule.enabled) return null; // 无任务文件或已禁用 → hub 不处理该房间
      const p = rule.pipeline ?? {};
      return {
        cleanMaxGapSec: hubCfg.cleanMaxGapSec ?? 30,
        // 磁盘水位闸门(issue #8):同上,与 reconciler 看门狗同一个配置键与默认值(不新增第二套口径)。
        diskMinGB,
        reconnectWindowMs: p.reconnectWindowMs ?? hubCfg.reconnectWindowMs,
        stageDir: hubCfg.stageDir ?? rootStageDir(),
        cookies: hubCfg.cookies ?? "",
        uploadMode: isUploadingMode(p.upload?.mode) ? "upload" : "stage", // upload/rolling → 传(rolling 只是上传时机提前,未建稿则整场管线兜底);其它值(含旧 stage-only)→ stage
        uploadPrivate: p.upload?.private !== false,                    // 缺省 / true → 仅自己可见
        uploadMeta: {
          tag: p.upload?.tag || defaultTag,
          tid: p.upload?.tid ?? defaultTid,
          desc: p.upload?.desc ?? uploadDefaults.desc,
          titleTemplate: (p.upload?.titleTemplate ?? "").trim() || uploadDefaults.titleTemplate,
          submissionTitleTemplate: (p.upload?.submissionTitleTemplate ?? "").trim() || uploadDefaults.submissionTitleTemplate,
          partTitleTemplate: (p.upload?.partTitleTemplate ?? "").trim() || uploadDefaults.partTitleTemplate,
        },
        timeZone: effectiveTimezone(opts.store),
        steps: p.steps,
        cleanup: p.cleanup,
        uploadBatchSize: p.uploadBatchSize,
        minSegmentSec: p.minSegmentSec,
        // 分 P 目标时长 = 录制任务创建时的分段时长(segmentSec)。
        // 两者是同一个值:录制按它切段,上传就按它聚合成分 P。不单独在 hub 规则里配。
        // 规则里的 segmentGroupSec 若存在(历史遗留)仍作覆盖,便于个别房间微调。
        segmentGroupSec: p.segmentGroupSec
          ?? (rule.recording?.sourceTaskId
            ? opts.store.getTask(rule.recording.sourceTaskId)?.segmentSec
            : undefined),
        // 输出格式同理读源任务(issue #137);无源任务 → undefined = original(现状)。
        // 实际容器由 pipeline 经 core effectiveStageFormat 与 uploadMode 一并算出(投稿强制 mp4)。
        outputFormat: rule.recording?.sourceTaskId
          ? opts.store.getTask(rule.recording.sourceTaskId)?.outputFormat
          : undefined,
        // worker 硬过滤:reconciler 据此把 broadcast members 收窄到选中的 worker。
        // 缺省/空(老规则)→ reconciler 不过滤 = 全部 worker(向后兼容)。
        workers: rule.workers,
        // 能力门控:reconciler 据此把 members 再收窄到能力满足的 worker(与 workers 取交集)。
        requires: rule.requires,
      };
    };

    const reconciler = new Reconciler({
      platform: hubCfg.platform ?? "douyin",
      transports,
      ledger,
      pipelineDeps,
      resolveCfg,
      timeZone: () => effectiveTimezone(opts.store),
      // 能力门控:按 worker id 取能力标签(hub.config.json 的 workers[].capabilities)。
      workerCapabilities: (id) => loadWorkers().find((w) => w.id === id)?.capabilities,
      nodeUpload: nodeUploadCfg,
      reconnectWindowMs: hubCfg.reconnectWindowMs,
      loadTransports: buildTransports,
      notify: pipelineDeps.notify, // 达重试上限升级 needs_manual 时,复用 pipeline 同源 EventCenter 通知(站内+webhook)
      staleMs: hubCfg.resources?.staleMs ?? 600_000,
      // 磁盘看门狗:节点数据根剩余 < 阈值 → master 告警(worker 常没配 webhook,靠这边兜底)。缺省 10GB。
      diskMinGB,
      // T7:跨房间的调度并发(同时派发几场 pull/merge/burn/upload 流程)。
      // 不等于 CPU 并行度 —— merge/burn 仍由 maxCpuParallel 闸住(上面那一行,缺省 1)。
      // T15:热读当前生效的那份配置(T7 的 dispatcher 每轮取),UI 改完立即生效、无需重启。
      maxConcurrentPipelinesLive: () => liveResources().maxConcurrentPipelines ?? 2,
      ...(hubCfg.maxWaitSec != null || hubCfg.settleSec != null
        ? {
            settle: {
              maxWaitMs: (hubCfg.maxWaitSec ?? 600) * 1000,
              pollMs: (hubCfg.settleSec ?? 15) * 1000,
            },
          }
        : {}),
    });

    // hub 受管录制任务同步:对每个 worker 计算「期望任务」并下发。
    // 规则里 recording.sourceTaskId 绑定的 master 任务 → 推送到规则 workers 勾选的节点;
    // 节点侧 applyRemoteTasks 按 (platform, roomSlug) 对账(收编/更新/两阶段删除)。
    const desiredFor = (workerId: string): RemoteTaskSpec[] => {
      const out: RemoteTaskSpec[] = [];
      const capsOfThis = loadWorkers().find((w) => w.id === workerId)?.capabilities;
      for (const rule of hubStore.listHubRules(hubDir)) {
        // T3 语义:「规则还在但被禁用 / 不再派给这个 worker」= 停用保留,**不是**删除。
        // 所以这两种情况都要继续产出 enabled:false 条目,让节点把已有任务停掉;
        // 只有「规则文件消失 / sourceTaskId 解绑 / 源任务不存在」才是缺席 → 两阶段删除。
        //
        // 早前这里对 !rule.enabled / 不在 workers / 能力不满足 都是 continue(直接缺席),
        // 于是「停用」和「删除」在节点侧无法区分 —— 取消勾选一个 worker 就把它的房间删了。
        // 归属判定 = core isWorkerAssigned(单一真理源,reconciler/状态探测/本机抑制共用)。
        const src = rule.recording?.sourceTaskId ? opts.store.getTask(rule.recording.sourceTaskId) : null;
        if (!src) continue;                        // 真删除意图:规则没绑源任务 / 源任务已删
        const p = platformForRoom(src.room);
        if (p.extractRoomSlug(src.room) !== rule.roomSlug) continue; // 绑定必须同房间
        // 该 worker 不再被派发这个房间(规则禁用 / 未勾选 / 能力不满足)→ 产 enabled:false,
        // 让节点**停用但保留**(T3)。字段与正常路径**同源构造**:早前写成两个 push 各抄一遍字段,
        // 抄漏一个字段就是「禁用路径丢配置」的静默 bug(自审发现,已合为一条)。
        const { assigned, enabled: specEnabled } = resolveSpecAssignment(rule, workerId, capsOfThis, src.enabled);
        // ⚠️ **local(master 本机)是特例**:它的 applyTasks 写的是**源任务本身**,
        // 而源任务的 enabled 是「用户要不要录这个房间」的**全局意图**,不是「本节点是否被选中」。
        // 若这里也按 targeted 强制 false,那么「把 local 从某房间 workers 里移除」会被写成
        // 「全局停录」→ 连 VPS1 一起停(线上实测:三节点全停)。
        // 本机的「不该录」由**专门的抑制机制**处理(localSuppressedSourceTaskIds →
        // startTask 只置意图不起子进程),不在这条路径上表达。
        const isLocalWorker = workerId === "local";
        const rollingFields = rollingSpecFields(
          { enabled: rule.enabled, mode: rule.pipeline?.upload?.mode, workers: rule.workers, steps: rule.pipeline?.steps },
          src.rollingUpload,
          isLocalWorker,
        );
        out.push({
          platform: p.id,
          roomSlug: rule.roomSlug,
          room: src.room,
          name: src.name,
          quality: src.quality,
          engine: src.engine,
          danmu: src.danmu,
          segmentSec: src.segmentSec,
          outputFormat: src.outputFormat,
          scheduleStart: src.scheduleStart,
          scheduleEnd: src.scheduleEnd,
          // 本机(local)要分两种情况,不能一刀切:
          //   ① 规则被**禁用** → 停用(source task enabled=false)。与远端节点一致:
          //      「规则禁用 = 暂停该房间」是全节点语义,本机不该例外。
          //   ② 规则启用、只是**没勾选本机** → 保持 src.enabled。本机的「不该录」由
          //      抑制机制(localSuppressedSourceTaskIds)表达,写成 enabled=false 会污染全局意图。
          // 远端节点:统一 `assigned && src.enabled`(停用保留时强制 false;见 core resolveSpecAssignment)。
          enabled: specEnabled,
          useCookie: src.useCookie,
          cookies: resolveTaskStreamCookies(src, opts.store),
          outDir: src.outDir,
          webhook: src.webhook,
          anchorName: src.anchorName,
          // 归属标记(issue #73):节点据此默认隐藏「受管且未分配且未在录」的任务。旧节点忽略该字段。
          assigned,
          // 边录边传(issue #40):**唯一判定 = core resolveRollingPolicy**,只在 master 这里算一次
          // (规则 mode=rolling / 旧任务开关迁移 / 规则 stage 优先 / 多节点重复投稿闸门),
          // 结果作为只读派生字段 `rollingEffective` 下发;录制端只读它,不再自行读规则判定。
          //   - 远端节点:`rollingUpload`(旧字段)同样下发生效值 —— 旧节点包只认它,行为与改前一致。
          //   - 本机(local):applyTasks 写的是**源任务本身**,其旧 `rollingUpload` 是用户旧值
          //     (迁移来源,不能被覆盖,同 enabled 的特例),故只更新派生字段 `rollingEffective`。
          ...rollingFields,
        });
      }
      return out;
    };
    // 周期 tick 与 web API 的「变更即同步」共用同一函数:内部守卫防重入,
    // 期间再有请求则合并成一轮补跑(期望任务是全量对账,不丢变更)。
    const syncTasks = async (req?: { force?: boolean }): Promise<void> => {
      // force 从 SyncGate 的累积标志取(在途请求的 force 必须落在**这一轮**,见 SyncGate 注释)。
      const force = hubSyncGate.beginRun(req?.force);
      if (hubSyncGate.running) {
        hubSyncGate.rerunRequested = true;
        return;
      }
      hubSyncGate.running = true;
      try {
        // 边录边传(issue #40):本机源任务的派生值每轮都重算 —— 规则被删/解绑/停用时 desiredFor 里
        // 已没有该任务的条目,applyTasks 不会再写它,不在这里回落就会残留旧的 true。
        try {
          refreshLocalRollingEffective(opts.store, hubDir, undefined, opts.warn);
        } catch (e) {
          opts.warn(`[rolling] 同步 tick 重算边录边传生效值失败: ${(e as Error).message}`);
        }
        for (const w of loadWorkers()) {
          const t = buildTransports().get(w.id);
          if (!t?.applyTasks) continue; // 该 transport 不支持任务同步 → 跳过(下轮再试)
          try {
            const desired = desiredFor(w.id);
            // T16:版本由内容派生;周期 tick 内容不变时复用同一版,避免假的 syncLag。
            // 回执只是观测:settings 写失败绝不能阻止本轮任务同步(否则一次磁盘/DB 故障会停录)。
            let expectedVersion: number | undefined;
            try {
              expectedVersion = hubReceiptSettings
                ? recordExpectedVersion(hubReceiptSettings, w.id, desired)
                : undefined;
            } catch (e) {
              opts.warn(`[hub] 记录期望版本 ${w.id} 失败(忽略,继续同步): ${(e as Error).message}`);
            }
            const r = await t.applyTasks({ desired, force, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
            // A safety-valve rejection means the expected set was NOT fully applied:
            // keep it visible as syncError instead of clearing the receipt.
            try {
              if (hubReceiptSettings) recordSyncError(hubReceiptSettings, w.id, r.rejected ? `rejected: ${r.rejected}` : null);
            } catch (e) {
              opts.warn(`[hub] 记录同步结果 ${w.id} 失败(忽略): ${(e as Error).message}`);
            }
            // 本机(local worker)的 pending 任务直接走同一进程里的 TaskManager 硬停,
            // 与远端 `_apply-tasks` 的 serve API 硬停语义一致:停源任务/删规则要立即停,
            // 不能等排空(否则 hub settle 会一直等这场直播自然收播,迟迟不建 job)。
            if (w.kind === "local" && r.pending.length > 0) {
              for (const key of r.pending) {
                const task = opts.store.listTasks().find((x) => {
                  try {
                    const p = platformForRoom(x.room);
                    return `${p.id}:${p.extractRoomSlug(x.room)}` === key;
                  } catch {
                    return false;
                  }
                });
                if (task && opts.manager.isRunning(task.id)) opts.manager.requestStop(task.id); // 不等退出,避免卡住同步 tick
              }
            }
            if (r.applied.length > 0 || r.removed.length > 0 || r.pending.length > 0) {
              opts.log(`[hub] 任务同步 ${w.id}: applied=${r.applied.length} removed=${r.removed.length}`
                + ` pending=${r.pending.length}${force ? " (forced)" : ""}`);
            }
            // 节点侧安全阀命中(T-2):必须让 master 侧看得见,否则「下发被拒」在 UI 上是静默的 ——
            // 用户只会看到任务没变,却不知道是节点在保护自己。
            if (r.rejected) {
              opts.warn(`[hub] 任务同步 ${w.id} 被节点安全阀拒绝(rejected=${r.rejected}, force=${force}):`
                + `本轮期望未完整生效(节点受管任务保持原状)。`
                + `若确认要缩容/清空该节点,在节点上设 DREC_ALLOW_SHRINK=1 后重试;`
                + `若 master 侧配置读取异常,先检查 config/hub/ 目录。`);
            }
          } catch (e) {
            const msg = (e as Error).message;
            // 失败原因必须留在 receipt 里:只有日志的话,重启后无从判断「期望没应用到」。
            // 同样包住:回执失败不能再抛进外层 catch 形成二次异常。
            try {
              if (hubReceiptSettings) recordSyncError(hubReceiptSettings, w.id, msg);
            } catch (recordErr) {
              opts.warn(`[hub] 记录同步失败原因 ${w.id} 失败: ${(recordErr as Error).message}`);
            }
            // 节点离线/命令失败 → 只 warn,下轮对账自愈,不打断 reconcile。
            opts.warn(`[hub] 任务同步 ${w.id} 失败: ${msg}`);
          }
        }
      } finally {
        if (hubSyncGate.endRun()) void syncTasks();
      }
    };
    hubSyncTasks = syncTasks;
    hubSyncGate.bind(syncTasks);

    // 正在进行的重跑(streamKey):检查与占用必须同步完成,否则并发请求会双双通过
    // isJobLive/hasStreamLock 检查、再被 withStreamLock 排队串行执行两次(上传类节点会重复投稿)。
    const retryingKeys = new Set<string>();
    // 手动单节点重跑:UI → web API → 这里。与 reconciler 共享同一 ResourcePool 流锁,保证同场不并发;
    // 上传类节点默认拒绝(可能已建稿/已 append),force 才放行(UI 二次确认)。
    const retryNode = async (
      streamKey: string,
      node: WorkflowNodeKey,
      force = false,
    ): Promise<{ ok: boolean; error?: string; code?: number }> => {
      const CORE: WorkflowNodeKey[] = ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"];
      const unsafe = (n: WorkflowNodeKey): boolean =>
        n === "upload_plain" || n === "append_danmu" || n === "append_livechat";
      if (!CORE.includes(node)) return { ok: false, error: `不可重跑的节点: ${node}`, code: 400 };
      if (unsafe(node) && !force) return { ok: false, error: `${node} 属上传类节点,需确认后才可重跑`, code: 400 };
      const parts = streamKey.split(":");
      if (parts.length < 3) return { ok: false, error: `非法 streamKey: ${streamKey}`, code: 400 };
      const platform = parts[0];
      const roomSlug = parts[1];
      const stageSub = join(hubCfg.stageDir ?? rootStageDir(), sanitizeStreamKey(streamKey));
      const job = ledger.get(streamKey);
      // 同场 pipeline 正在跑(持流锁 / live job)→ 不排队,直接 409。
      // 否则会静默等在锁后,等当前上传完成又重跑一次,造成重复烧录/重复分 P。
      if (isJobLive(streamKey) || pool.hasStreamLock(streamKey)) {
        return { ok: false, error: "任务正在执行,不能重跑节点", code: 409 };
      }
      // 已建稿后重传 P1 会重复投稿;已有 append done 再跑 append 会重复分 P → 拒绝(除非 force 且 UI 二次确认)。
      if (node === "upload_plain" && job?.bv) {
        const appended = ["append_danmu", "append_livechat"].some(
          (k) => ledger.getNodeState(streamKey, k as WorkflowNodeKey)?.state === "done",
        );
        if (appended) return { ok: false, error: `已建稿(${job.bv})且已有分 P,不能重跑 P1(会重复投稿)`, code: 409 };
      }
      if (retryingKeys.has(streamKey)) {
        return { ok: false, error: "该场已有重跑在执行,请稍后", code: 409 };
      }
      retryingKeys.add(streamKey);
      return runWithJob(streamKey, async () => {
        try {
          return await pool.withStreamLock(streamKey, async () => {
            throwIfAborted();
            ledger.setState(streamKey, "retrying", {}, { force: true }); // 人工重跑:允许 done 场重跑单节点
            const cfg = resolveCfg(platform, roomSlug);
            if (!cfg) {
              ledger.setState(streamKey, "failed", { error: `房间未开 hub: ${streamKey}` });
              return { ok: false, error: `房间未开 hub: ${streamKey}`, code: 400 };
            }
            // 分段模式:产出/烧录/上传是一个整体(逐段 remux + 多文件建稿),不做单节点重跑
            // (单段重烧会与已建稿的分 P 错位)。用「重新运行」整场重跑(幂等:已建稿只补 append)。
            if (cfg.steps?.mergeSegments === false) {
              return { ok: false, error: "分段上传模式不支持单节点重跑,请用「重新运行」整场重跑", code: 400 };
            }
            ledger.backfillNodeStates(streamKey);
            const derived = deriveStageProducts(stageSub, effectiveStageFormat(cfg.outputFormat, cfg.uploadMode));
            if (!derived) {
              ledger.setState(streamKey, "failed", { error: `stage 产物缺失,无法重跑: ${stageSub}` });
              return { ok: false, error: `stage 产物缺失,无法重跑: ${stageSub}`, code: 409 };
            }
            const products = job?.outputStem ? withOutputStem(derived, job.outputStem) : derived;
            const workflow = buildWorkflow({
              streamKey, stageSub, products, deps: pipelineDeps, cfg, log: opts.log,
              willUpload: cfg.uploadMode === "upload",
              ...burnFlags(cfg.steps),
              segmentCount: 0,
            });
            const r = await runWorkflowNodes({
              streamKey, nodes: workflow.nodes, edges: workflow.edges, ctx: workflow.ctx,
              pool, forceRetry: new Set<WorkflowNodeKey>([node]),
            });
            if (r.ok) {
              if (cfg.uploadMode === "upload") {
                const bv = ledger.get(streamKey)?.bv ?? "";
                ledger.markDone(streamKey, bv);
                if (bv) opts.onEvent({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}`, streamKey });
              } else {
                // stage 模式正常收口必须带显式标记(issue #188):空 error 会被队列判成红灯事故。
                closeStageReady(ledger, streamKey, cfg.uploadMode);
              }
              return { ok: true };
            }
            const errText = r.failed.length
              ? ledger.getNodeState(streamKey, r.failed[0])?.error ?? `节点失败: ${r.failed.join(",")}`
              : `节点被阻断: ${r.blocked.join(",")}`;
            if (errText === USER_STOP || r.blocked.some((k) => ledger.getNodeState(streamKey, k)?.error === USER_STOP)) {
              ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
              return { ok: false, error: USER_STOP, code: 409 };
            }
            ledger.setState(streamKey, "failed", { error: errText });
            return { ok: false, error: errText, code: 500 };
          });
        } catch (e) {
          if (isJobAbort(e)) {
            ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
            return { ok: false, error: USER_STOP, code: 409 };
          }
          throw e;
        }
      }).finally(() => retryingKeys.delete(streamKey));
    };
    hubRetryNode = (streamKey: string, node: WorkflowNodeKey, o?: { force?: boolean }) =>
      retryNode(streamKey, node, o?.force === true);
    hubStopJob = (streamKey: string) => reconciler.stopJob(streamKey);
    hubRunNow = (opts) => reconciler.runNow(opts);
    // 队列页的「排队位次 / 资源占用」来源:读同一 ResourcePool 实例(进程内共享)。
    hubPoolSnapshot = () => pool.snapshot();

    const stop = startHub({
      tasks: () => opts.store.listTasks(),
      isRecording: (id: number) => opts.manager.isRecording(id),
      reconcileAll: () => reconciler.reconcileAll(),
      pollUploadQueue: () => reconciler.pollUploadQueue(),
      uploadQueuePollMs: nodeUploadCfg.pollMs,
      settleMs: hubCfg.settleMs ?? 90_000,
      pollMs: hubCfg.pollMs ?? 3_000,
      reconcileIntervalMs: hubCfg.reconcileIntervalMs ?? 30 * 60_000,
      syncTasks,
      syncIntervalMs: hubCfg.syncIntervalMs ?? 60_000,
    });

    void refreshRecordingStatus();
    // T17:探测周期自适应 —— 有节点在录时 2s(用户最关心「录到没录到」的时刻),
    // 全空闲时 10s(没人录的时段不必频繁 SSH)。固定 5s 是两头都不讨好:
    // 开播瞬间那几秒仍显陈旧,而空闲时又在白跑 SSH。
    // 用**递归 setTimeout** 而非 setInterval:自适应周期在 setInterval 里做不到
    // (间隔在创建时就固定了),而且 setInterval 会在上一轮 SSH 还没回来时叠加下一轮。
    const RECORDING_BUSY_POLL_MS = 2_000;
    const RECORDING_IDLE_POLL_MS = 10_000;
    let recordingStatusTimer: ReturnType<typeof setTimeout> | null = null;
    // stop() 之后不许再排下一轮。
    // 自审发现:stop 只 clearTimeout 了**已排定**的那一次,但如果那一刻 refreshRecordingStatus()
    // 正在 SSH 途中,它的 .finally 会在 stop 之后**再排一轮** → hub 停了、探测还在跑,
    // 而且会一直跑下去(unref 只保证不挡进程退出,不代表逻辑停了)。这个泄漏没有任何症状,
    // 除非你恰好在 stop 的时候看了一眼 SSH 次数。
    let recordingProbeStopped = false;
    const scheduleRecordingStatusProbe = (delayMs: number): void => {
      if (recordingProbeStopped) return;
      recordingStatusTimer = setTimeout(() => {
        void refreshRecordingStatus().finally(() => {
          if (recordingProbeStopped) return;
          // 任何在录/不可达的节点 → 下一轮用快周期;全空闲 → 慢周期。
          // 用 finally:refreshRecordingStatus 内部已自己吞异常,这里只是保证
          // 「无论成功失败都继续排下一轮」——否则一次意外会让状态探测**永久停摆**
          // (自审发现:第一版把调度放在 then 里,失败路径直接断链,且没人会发现)。
          const busy = [...hubRecordingSnapshot.values()].some(
            (rows) => rows.some((r) => r.state === "recording" || r.state === "unavailable"),
          );
          scheduleRecordingStatusProbe(busy ? RECORDING_BUSY_POLL_MS : RECORDING_IDLE_POLL_MS);
        });
      }, delayMs);
      recordingStatusTimer.unref?.();
    };
    scheduleRecordingStatusProbe(RECORDING_IDLE_POLL_MS);
    opts.log(`[hub] 已启用，${loadWorkers().length} 个 worker`);
    return () => {
      stop();
      recordingProbeStopped = true;
      if (recordingStatusTimer) clearTimeout(recordingStatusTimer);
      hubRecordingSnapshot = new Map();
      hubSyncTasks = undefined;
      hubSyncGate.unbind(); // 必须解绑:否则 stop 之后的同步请求会打到已停的旧 runner(自审发现)
      hubRetryNode = undefined;
      hubStopJob = undefined;
      hubRunNow = undefined;
      hubPoolSnapshot = undefined;
      hubReceiptSettings = undefined;
    };
  },
  async testWorker(cfg) {
    // 注意:不能调 registerBuiltinTransports —— 那是全量 registry.set("local", …) 覆盖,
    // 若在 `task serve --hub` 运行期间调用会永久降级共享的 "local" transport 工厂
    // (isDone 退化恒 true → reconciler 不再等本地收播就合并残片;taskRooms 塌成 {} → 聚类失效)。
    // 探测只需一次性、不进 registry 的 scoped transport 实例,直接按 cfg.kind 构造。
    const { LocalTransport, SshTransport } = await import("@drec/orchestrator");
    const { ffprobeVideo } = await import("@drec/post-process");
    const { ensureNodeIdentity } = await import("@drec/app");
    const { statSync } = await import("node:fs");
    const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
      const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
      const endMs = statSync(file).mtimeMs;
      return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
    };
    const id = cfg.id ?? "test";
    const t = cfg.kind === "local"
      // 本机探测也带上身份(local 通常 id 固定 "local",但探测时也返回 nodeId 供 UI 展示一致性)。
      ? new LocalTransport({
          id, recordingsDir: `${cfg.dataRoot}/recordings`, taskRooms: {}, ffprobe,
          nodeIdentity: () => { const i = ensureNodeIdentity(cfg.dataRoot); return { nodeId: i.nodeId, hostname: i.hostname }; },
        })
      : new SshTransport({ id, host: cfg.host!, dataRoot: cfg.dataRoot! });
    try {
      // ping 内置超时(local 瞬时;ssh 6s)。这里不再额外包 20s——探针本就轻量。
      await t.ping!();
      // 顺带读节点稳定身份(local 无身份注入 → null;ssh 读 _node-id)。旧 bundle 无该命令 → 也返 null。
      // UI 用它作为 worker id,免去 master 自分配 worker-N(删了重建就换号的幽灵 id 问题)。
      const ident = await t.nodeId?.().catch(() => null) ?? null;
      return ident ? { ok: true, nodeId: ident.nodeId, hostname: ident.hostname } : { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  async probeAllWorkers(): Promise<WorkerStatus[]> {
    // scoped 一次性 transport(不进全局 registry,不污染运行中的 hub);逐 worker ping,allSettled 汇总。
    const { LocalTransport, SshTransport } = await import("@drec/orchestrator");
    const { ffprobeVideo } = await import("@drec/post-process");
    const { statSync } = await import("node:fs");
    const { workerStore, rootHubConfig, withMasterReceipt } = await import("@drec/app");
    const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
      const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
      const endMs = statSync(file).mtimeMs;
      return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
    };
    const workers = workerStore.listWorkers(rootHubConfig());
    const results = await Promise.allSettled(workers.map(async (w) => {
      const t = w.kind === "local"
        ? new LocalTransport({
            id: w.id, recordingsDir: `${w.dataRoot}/recordings`, taskRooms: {}, ffprobe,
            // T16:本机也要能报版本,否则漂移告警漏掉 master 自己那台。
            nodeStatus: () => {
              let appliedVersion: number | null = null;
              let appliedAt: number | null = null;
              let appVersionAtApply: string | null = null;
              try {
                const st = readManagedState(join(w.dataRoot ?? "", "config", "managed"));
                appliedVersion = st?.version ?? null;
                appliedAt = st?.savedAt ?? null;
                appVersionAtApply = st?.appVersion ?? null;
              } catch { /* 未同步过 → null */ }
              return { appVersion: APP_VERSION, appliedVersion, appliedAt, appVersionAtApply, taskCount: 0, managedCount: 0 };
            },
          })
        : new SshTransport({ id: w.id, host: w.host!, dataRoot: w.dataRoot! });
      await t.ping!();
      // 版本回执 / 磁盘剩余都是可选观测:拿不到(旧 bundle/不可达)就当没有 —— **绝不能因此让 status 失败**。
      // 两者并行,避免慢节点上串行叠加 ssh 超时。
      const [status, diskFreeGB] = await Promise.all([
        (async () => { try { return (await t.nodeStatus?.()) ?? null; } catch { return null; } })(),
        (async (): Promise<number | undefined> => {
          try {
            const g = await t.diskFreeGB?.();
            return typeof g === "number" && Number.isFinite(g) ? g : undefined;
          } catch { return undefined; }
        })(),
      ]);
      return { status, diskFreeGB };
    }));
    // 水位与磁盘看门狗同源(hub.config resources.diskMinGB);读不到/损坏 → 缺省口径,不抛。
    let rawMin: unknown;
    try { rawMin = (JSON.parse(readFileSync(rootHubConfig(), "utf-8")) as { resources?: { diskMinGB?: unknown } }).resources?.diskMinGB; } catch { rawMin = undefined; }
    const diskMinGB = resolveDiskMinGB(rawMin, (m) => console.warn(m)).gb;
    return workers.map((w, i) => {
      const r = results[i];
      if (r.status !== "fulfilled") {
        return { id: w.id, ok: false, error: (r.reason as Error)?.message ?? String(r.reason) };
      }
      const { status: ns, diskFreeGB } = r.value;
      const disk = diskFreeGB !== undefined ? { diskFreeGB, diskMinGB } : {};
      const base = ns
        ? { id: w.id, ok: true, appVersion: ns.appVersion, appliedVersion: ns.appliedVersion, appliedAt: ns.appliedAt, ...disk }
        : { id: w.id, ok: true, ...disk };
      // T16:把 master 侧期望版本与最近同步失败附在节点回执上;旧节点/未注入 → 字段缺省。
      return hubReceiptSettings ? withMasterReceipt(base, hubReceiptSettings) : base;
    });
  },
};

// 全部 worker 的存活/版本/磁盘探测:每个 ssh worker 要 3 条 ssh,多个浏览器标签页会各自轮询 →
// 包 30 秒 TTL 缓存 + 并发合并,探测成本与标签页数量无关(新增/删除节点后最多 30 秒内状态滞后)。
hubStarter.probeAllWorkers = ttlMemoAsync(hubStarter.probeAllWorkers!.bind(hubStarter), PROBE_CACHE_MS);

// ─── task 子命令组（stateful app 层：sqlite 持久化 + 运行任务）─────────────────
// webhook 解析复用全局 --discord-webhook / env DISCORD_WEBHOOK（settings 表在 runTask 内兜底）。
// 用 `||` 而非 `??`:env `DISCORD_WEBHOOK=`(set-but-empty,docker .env 常见)会让 `??` 透出空串,
// 进而毒化下游 `getWebhook() ?? settings.discordWebhook` 链(?? 不接空串)→ UI 设的全局 webhook
// 永远读不到。空串一律归一为 undefined,下游 `??` 才能正确回落到 settings 表。
const taskCmd = buildTaskCommand(
  () =>
    (program.opts() as { discordWebhook?: string }).discordWebhook ||
    process.env.DISCORD_WEBHOOK ||
    undefined,
  hubStarter,
);

// ─── serve：Web 控制台（T-22 第 4 步:命令定义回归 cli,装配在 app/serve.ts）─────────
taskCmd
  .command("serve")
  .description("启动 Web 控制台：HTTP 服务 + SPA + 定时调度守护（默认开；--no-schedule 关）")
  .option("--port <n>", "监听端口（默认 7860）")
  .option("--host <host>", "监听地址（默认所有网卡；worker 建议 127.0.0.1）")
  .option("--db <path>", "数据库路径")
  // 调度默认开：启用的任务无窗口=24h 录、有窗口=窗口内录。--no-schedule 退化为纯手动控制台。
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
    });
  });

// ─── tui：终端交互界面（连 task serve 的 REST API）─────────────────────────────
// T-22 第 3 步:从 app/cli-task.ts 挪到 cli —— 命令定义属入口层,且 app(L4) 不该依赖 @drec/tui(L0)。
taskCmd
  .command("tui")
  .description("终端交互界面：列表/启停/日志（连 task serve 的 REST API，默认 :7860）")
  .option("--api <url>", "serve API 地址", "http://localhost:7860")
  .action(async (o: { api: string }) => {
    // 加载独立的 TUI bundle（dist/tui.mjs）。用变量 specifier，让 esbuild 不要把
    // 它(及 react/ink)静态打进主 bundle —— 否则主 bundle 顶层 import react 会让
    // docker 里的 `task serve` 启动即崩(无 node_modules)。运行时相对 dist/douyin-rec.mjs 解析。
    const tuiMod = "./tui.mjs";
    const { launchTui } = (await import(tuiMod)) as typeof import("@drec/tui");
    await launchTui({ api: o.api });
  });

program.addCommand(taskCmd);

// ─── cookie 子命令组：管理全局抖音账号 cookie（所有任务共享）────────────────────
program.addCommand(buildCookieCommand());

/**
 * 扫 `/proc`,找出「有媒体下载孙进程(ffmpeg/mesio)」的 record 子进程,返回其房间身份。
 *
 * 唯一真理:`_is-done`(某房间是否仍在录)与 `_recording-status`(全部在录房间)共用这一个扫描,
 * 避免两处 `/proc` 解析逻辑各自漂移。非 Linux(本地 macOS 开发)无 `/proc` → 返回空数组。
 *
 * 判据:record 子进程命令行含 `--room <URL/房间号>`,且 `/proc/<pid>/task/<pid>/children`
 * 非空(= 正在写盘的 ffmpeg/mesio)。只在轮询等开播、无下载子进程 = 未在录。
 */
function scanRecordingRooms(): { platform: string; roomSlug: string }[] {
  const rooms = new Map<string, { platform: string; roomSlug: string }>();
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      let cmdline: string[];
      try {
        cmdline = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean);
      } catch {
        continue; // 进程刚退出 / 权限不足
      }
      const roomIdx = cmdline.indexOf("--room");
      if (roomIdx < 0 || roomIdx + 1 >= cmdline.length) continue;
      try {
        const platform = platformForRoom(cmdline[roomIdx + 1]);
        const roomSlug = platform.extractRoomSlug(cmdline[roomIdx + 1]);
        const children = readFileSync(`/proc/${entry.name}/task/${entry.name}/children`, "utf8").trim();
        if (children) rooms.set(`${platform.id}:${roomSlug}`, { platform: platform.id, roomSlug });
      } catch {
        /* 进程刚退出,或房间无法解析 */
      }
    }
  } catch {
    /* 非 Linux(本地开发)无 /proc → 视为无进程 */
  }
  return [...rooms.values()];
}

// ─── recheck-verify（T32 一次性重核工具）────────────────────────────────
// 把「B站 pages 还没同步就核验」导致的假 mismatch(needs_manual)按 B站实况翻回 done。
// 默认 dry-run;必须显式 --apply 才落库。护栏见 packages/cli/src/hub-recheck-verify.ts。
//
// ⚠️ 用**单段命令名** `recheck-verify`,不用 `hub recheck-verify`:
// commander 会把两段式名字按空格拆成「命令 hub + 位置参数 recheck-verify」,
// 于是 action 的第一个参数被当成那个字符串而不是 options 对象 → `--apply` **静默失效**
// (dry-run 假装成功,实际什么都没写)。这类「看起来跑了但没生效」必须避免。
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

// ─── _is-done <dataRoot> <roomSlug>（隐藏子命令，供 master 通过 SSH 调用）────────
// 只查「该房间」是否还有活着的下载进程(ffmpeg/mesio 子进程)在写盘,不再数全机 ffmpeg:
// 之前用全局 ffmpeg 计数,别的房间还在录会把本房间也当成未收播,settle 一直空等。
function roomRecordingAlive(roomSlug: string): boolean {
  return scanRecordingRooms().some((room) => room.roomSlug === roomSlug);
}

program
  .command("_is-done <dataRoot> <roomSlug>", { hidden: true })
  .description("(内部) 判断该房间是否已收播(供 master ssh settle)")
  .action((_dataRoot: string, roomSlug: string) => {
    process.stdout.write((roomRecordingAlive(roomSlug) ? "false" : "true") + "\n");
  });

program
  .command("_recording-status <dataRoot>", { hidden: true })
  .description("(内部) 输出当前正在录制的房间,供 master 控制台轮询")
  .action(async (dataRoot: string) => {
    const rooms = scanRecordingRooms();
    // F1:同时带回边录边传的实时进度(只读 sidecar;失败不影响 rooms,旧 master 忽略多出的字段)。
    let rolling: unknown[] = [];
    try {
      const { join: pathJoin } = await import("node:path");
      const { scanRollingSessions } = await import("@drec/orchestrator");
      rolling = scanRollingSessions(pathJoin(dataRoot, "recordings"), rooms);
    } catch { /* 进度是附加信息,拿不到就空 */ }
    process.stdout.write(JSON.stringify({ rooms, rolling }) + "\n");
  });

// ─── _inventory <dataRoot>（隐藏子命令，供多节点编排 master 通过 SSH 调用）──────────
// master 通过 ssh 在 slave 上执行 `node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>`。
// slave 扫描自己的 recordings 目录，输出 JSON { recordings: NodeRecording[] } 到 stdout。
// 注意：此命令在 slave（VPS）上运行，不在 master 本地运行，也不是用户可见子命令。
program
  .command("_inventory <dataRoot>", { hidden: true })
  .description("(内部) 扫描 <dataRoot>/recordings，输出 JSON 清单（供 master ssh 调用）")
  .action(async (dataRoot: string) => {
    const { join: pathJoin } = await import("node:path");
    const { statSync } = await import("node:fs");
    const { TaskStore } = await import("@drec/app");
    const { ffprobeVideo } = await import("@drec/post-process");
    const { scanInventory, segmentSecByAnchorOf } = await import("@drec/orchestrator");

    // 打开 slave 自身的 db，构建 taskRooms（anchorName/name → roomSlug）
    const dbPath = pathJoin(dataRoot, "db", "douyin-rec.db");
    const store = new TaskStore(dbPath);
    const taskRooms: Record<string, string> = {};
    const tasks = store.listTasks();
    for (const task of tasks) {
      try {
        const slug = platformForRoom(task.room).extractRoomSlug(task.room);
        if (task.name) taskRooms[task.name] = slug;
        if (task.anchorName) taskRooms[task.anchorName] = slug;
      } catch { /* skip tasks whose platform can't be resolved */ }
    }
    const segmentSecByAnchor = segmentSecByAnchorOf(tasks);

    // ffprobe 适配器：durationMs via ffprobeVideo + mtime → startMs/endMs
    const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
      const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
      const endMs = statSync(file).mtimeMs;
      return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
    };

    const recordingsDir = pathJoin(dataRoot, "recordings");
    const inventory = await scanInventory(recordingsDir, taskRooms, ffprobe, { segmentSecByAnchor });
    process.stdout.write(JSON.stringify(inventory) + "\n");
  });

// ─── _disk <dataRoot>（隐藏子命令，供 master 通过 SSH 调用）──────────────────────
// 输出该节点录制数据根所在卷的剩余空间(GB)。master 侧磁盘看门狗用 —— 不依赖 worker
// 自身 webhook 是否配置(worker 常不配 DISCORD_WEBHOOK,告警发不出去)。
program
  .command("_disk <dataRoot>", { hidden: true })
  .description("(内部) 输出数据根剩余空间 GB(供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    const { statfs } = await import("node:fs/promises");
    try {
      const st = await statfs(dataRoot);
      const freeGB = freeGBOf(st);
      process.stdout.write(JSON.stringify({ freeGB: Number(freeGB.toFixed(2)) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
      process.exitCode = 1;
    }
  });

// ─── _tasks <dataRoot>（隐藏子命令，供 master 通过 SSH 调用）──────────────────────
// 读/建该节点的稳定身份(node.json):master 首次配置该节点时据此拿到 nodeId,而非自分配 worker-N。
// 副作用:文件不存在则生成 —— 与 serve 启动时的 ensureNodeIdentity 同一份文件、同一逻辑。
program
  .command("_node-id <dataRoot>", { hidden: true })
  .description("(内部) 输出节点稳定身份 JSON(供 master ssh 调用;不存在则生成)")
  .action(async (dataRoot: string) => {
    const { ensureNodeIdentity } = await import("@drec/app");
    // 让 paths 的函数按该 dataRoot 工作(_node-id 传的是 worker 的数据根)。
    process.env.DOUYIN_REC_ROOT = dataRoot;
    process.stdout.write(JSON.stringify(ensureNodeIdentity()) + "\n");
  });

// 输出本节点全部任务的隐私安全投影(无 cookies)。master 的任务同步对账用。
program
  .command("_tasks <dataRoot>", { hidden: true })
  .description("(内部) 输出节点任务清单 JSON(供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    const { join: pathJoin } = await import("node:path");
    const { TaskStore, listNodeTasks } = await import("@drec/app");
    const store = new TaskStore(pathJoin(dataRoot, "db", "douyin-rec.db"));
    process.stdout.write(JSON.stringify({ tasks: listNodeTasks(store) }) + "\n");
  });

// ─── _apply-tasks <dataRoot> <base64>（隐藏子命令，供 master 通过 SSH 调用）────────
// base64 = JSON { desired: RemoteTaskSpec[] }。按 (platform, roomSlug) 对账:
// 收编/新建期望任务、两阶段删除不再期望的受管任务。cookies 只走可信 ssh/本地通道。
program
  .command("_apply-tasks <dataRoot> <base64>", { hidden: true })
  .description("(内部) 应用 master 下发的期望任务(供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    const { join: pathJoin } = await import("node:path");
    const { TaskStore, applyTasksPayload } = await import("@drec/app");
    const store = new TaskStore(pathJoin(dataRoot, "db", "douyin-rec.db"));
    // T16:payload 的 expectedVersion 由 applyTasksPayload 透传到快照;旧 master 缺字段 → 版本 0。
    const result = applyTasksPayload(store, b64, undefined, {
      // 审计快照:目录由 dataRoot 显式派生(本命令只带 dataRoot,无 DOUYIN_REC_ROOT —— 见 managed-state.ts)。
      managedStateDir: pathJoin(dataRoot, "config", "managed"),
    });
    // 不再期望的受管任务必须**硬停**(而非排空):这是「用户停源任务/删规则」的明确意图,
    // 排空会等到直播自然收播,hub 的 settle 因而一直卡着不建 job。
    // `_apply-tasks` 是独立短命进程,没有 TaskManager 引用,只能走本机 serve 的
    // POST /api/tasks/:id/stop → 由 serve 内的 manager 置 expected 停掉子进程(不会触发崩溃自愈重启)。
    if (result.pending.length > 0) {
      const apiBase = process.env.DREC_SERVE_API ?? "http://127.0.0.1:7860";
      for (const key of result.pending) {
        const task = store.listTasks().find((x) => {
          try {
            const p = platformForRoom(x.room);
            return `${p.id}:${p.extractRoomSlug(x.room)}` === key;
          } catch {
            return false;
          }
        });
        if (!task) continue;
        try {
          // internal=1 仅允许本机回环:serve 借此放行 hub 受管任务的硬停(外部 API 仍 403)。
          const res = await fetch(`${apiBase}/api/tasks/${task.id}/stop?internal=1`, { method: "POST" });
          if (!res.ok) {
            console.error(`[task-sync] 硬停任务 id=${task.id}(${key}) 失败: HTTP ${res.status}`);
          }
        } catch (e) {
          // serve 未起/重启中 → 下一轮对账会再进 pending 重试;若 serve 一直不可达则回落 daemon 排空兜底。
          console.error(`[task-sync] 硬停任务 id=${task.id}(${key}) 失败: ${(e as Error).message}`);
        }
      }
    }
    // 新建或已有但 anchorName 仍为 null 的受管任务:通知本机 serve 后台重抓主播名。
    // 短命进程无法自行调用 fetchAnchorName(依赖平台 vendor 包),转交给 serve 进程做(有完整运行时)。
    // fire-and-forget:失败只 warn,下次 enable/disable 或开播时会再次触发。
    // 逐个 await 会拖慢本命令(ssh 往返),故并发发 + 短超时:serve 慢/挂时不能阻塞同步对账。
    const apiBase = process.env.DREC_SERVE_API ?? "http://127.0.0.1:7860";
    const needsAnchor = store.listTasks().filter((t) => t.managedBy === "hub" && !t.anchorName);
    await Promise.allSettled(
      needsAnchor.map(async (t) => {
        try {
          await fetch(`${apiBase}/api/tasks/${t.id}/refresh-anchor`, {
            method: "POST",
            signal: AbortSignal.timeout(3000),
          });
        } catch {
          // serve 未起/超时 → 忽略,开播时 task-manager 会从日志抓名字兜底。
        }
      }),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  });

// (内部) 读本节点某任务的日志尾巴(F3):master 在 fleet 模式下代查节点日志,不必登节点看网页。
// 日志在 serve 进程的内存环形缓冲里,短命 CLI 进程读不到 → 转问本机 serve(与 _apply-tasks 同一手法)。
// 只读:serve 未起/任务不存在都返回 {lines:[],error} 且**退出码 0**,可观测性不能反过来打断调用方。
program
  .command("_task-logs <dataRoot> <taskId> <lines>", { hidden: true })
  .description("(内部) 输出某任务最近 n 行日志 JSON(供 master ssh 代查)")
  .action(async (dataRoot: string, taskIdRaw: string, linesRaw: string) => {
    void dataRoot; // 数据根只用于与其它隐藏命令保持同一签名;日志来自 serve 进程,不经这里读盘。
    const taskId = Number(taskIdRaw);
    // 行数夹取:防一个调用把整段日志(上千行)拖过 ssh。默认 200,上限 1000。
    const asked = Number(linesRaw);
    const lines = Number.isFinite(asked) ? Math.min(1000, Math.max(1, Math.trunc(asked))) : 200;
    const apiBase = process.env.DREC_SERVE_API ?? "http://127.0.0.1:7860"; // issue-guard: allow (回环地址,与 _apply-tasks 同一约定)
    if (!Number.isFinite(taskId)) {
      process.stdout.write(JSON.stringify({ lines: [], error: `taskId 非法: ${taskIdRaw}` }) + "\n");
      return;
    }
    try {
      const res = await fetch(`${apiBase}/api/tasks/${taskId}/logs`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        process.stdout.write(JSON.stringify({ lines: [], error: `serve HTTP ${res.status}` }) + "\n");
        return;
      }
      const body = (await res.json()) as { lines?: unknown };
      const all = Array.isArray(body.lines) ? body.lines.filter((x): x is string => typeof x === "string") : [];
      // 脱敏后才出节点:日志里可能带 cookie(vendored 取流代码在异常信息里打印整串)。
      process.stdout.write(JSON.stringify({ lines: redactLogLines(all.slice(-lines)) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ lines: [], error: `读本机 serve 失败: ${(e as Error)?.message ?? e}` }) + "\n");
    }
  });

// (内部) 节点状态回执(T16):master 想知道「这台节点应用了哪一版期望、跑的是哪个 bundle」。
// 输出 {appVersion, appliedVersion, appliedAt, taskCount, managedCount};没有快照(从未同步过)→ 字段为 null。
// 只读、不碰任务、不写盘 —— 旧 bundle 没有本命令时,master 侧按「unknown」处理(不报错)。
program
  .command("_node-status <dataRoot>", { hidden: true })
  .description("(内部) 输出节点应用回执 JSON(appVersion/appliedVersion/appliedAt/任务数;供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    const { join: pathJoin } = await import("node:path");
    const { TaskStore, readManagedState } = await import("@drec/app");
    const { APP_VERSION } = await import("@drec/app");
    let appliedVersion: number | null = null;
    let appliedAt: number | null = null;
    let appVersionAtApply: string | null = null;
    try {
      // 快照目录与 _apply-tasks 同一推导(显式传 dataRoot,不从 env 推导)。
      const st = readManagedState(pathJoin(dataRoot, "config", "managed"));
      if (st) {
        appliedVersion = st.version;
        appliedAt = st.savedAt;
        appVersionAtApply = st.appVersion ?? null;
      }
    } catch {
      /* 读不到 = 从未同步过 / 目录缺失 → 保持 null(不是错误) */
    }
    let taskCount = 0;
    let managedCount = 0;
    try {
      const store = new TaskStore(pathJoin(dataRoot, "db", "douyin-rec.db"));
      const tasks = store.listTasks();
      taskCount = tasks.length;
      managedCount = tasks.filter((t) => t.managedBy === "hub").length;
    } catch {
      /* db 打不开 → 计数保持 0;不因此让整条命令失败(版本信息仍然有用) */
    }
    // 处理任务表活动快照(plans/036 T3):库不存在 → 全空;读失败 → 省略字段(旧 master 本就忽略)。
    let procActive: ProcActiveDTO | undefined;
    try {
      const { readProcActive } = await import("@drec/proc-queue");
      procActive = readProcActive(dataRoot);
    } catch {
      /* 任务表读不到不拖垮整条命令(版本信息仍有用) */
    }
    process.stdout.write(JSON.stringify({
      appVersion: APP_VERSION,
      appliedVersion,
      appliedAt,
      appVersionAtApply,
      taskCount,
      managedCount,
      ...(procActive ? { procActive } : {}),
    }) + "\n");
  });

// (内部) 处理任务表人工清理(plans/036 §2.3):done/cancelled 超 7 天删;`--purge-failed` 额外删 failed。
// uncertain 永不在此删(须先在任务表里 ack);库不存在 → 0,不创建文件。输出 {deleted}。
program
  .command("_proc-gc <dataRoot>", { hidden: true })
  .option("--purge-failed", "额外清理 failed 行")
  .description("(内部) 清理节点处理任务表(done/cancelled > 7 天;可选 failed)")
  .action(async (dataRoot: string, opts: { purgeFailed?: boolean }) => {
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
  });

// (内部) 远端入队(plans/036 §2.4 / T9a):master 经 ssh 把 remux 任务送进本节点的处理任务表。
// 请求 = base64(EnqueueRequest);输出单行 EnqueueResponse。第一期只受理 remux,路径校验用本节点 allowedRoots + realpath。
program
  .command("_enqueue <dataRoot> <base64>", { hidden: true })
  .description("(内部) 入队处理任务(仅 remux;供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    try {
      await applyNodeDataRoot(dataRoot);
      const { decodeEnqueue } = await import("@drec/core");
      const { handleEnqueue } = await import("@drec/app");
      const capabilities = listProcessors().map((p) => p.kind);
      process.stdout.write(JSON.stringify(handleEnqueue(dataRoot, decodeEnqueue(b64), { capabilities })) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
      process.exitCode = 1;
    }
  });

// (内部) 处理任务回执(plans/036 §2.4 / T9a):请求 = base64(jobId 字符串数组);输出 {receipts: ProcessReceipt[]}。
// 库不存在 / 未知 jobId → 不出现在 receipts 里。
program
  .command("_proc-status <dataRoot> <base64>", { hidden: true })
  .description("(内部) 查询处理任务回执(供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    try {
      const { decodeJobIds, handleProcStatus } = await import("@drec/app");
      process.stdout.write(JSON.stringify({ receipts: handleProcStatus(dataRoot, decodeJobIds(b64)) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
      process.exitCode = 1;
    }
  });

// (internal) Cancel processing jobs (plans/038): pending rows are cancelled directly; running rows are closed out by the runner after verification.
program
  .command("_proc-cancel <dataRoot> <base64>", { hidden: true })
  .description("(internal) cancel processing jobs (called by the master over ssh)")
  .action(async (dataRoot: string, b64: string) => {
    try {
      const { decodeJobIds, handleProcCancel } = await import("@drec/app");
      process.stdout.write(JSON.stringify({ receipts: handleProcCancel(dataRoot, decodeJobIds(b64)) }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
      process.exitCode = 1;
    }
  });

// 节点侧上传(experimental,plans/027)的隐藏子命令隔离在独立文件,便于快速开关/回退。
registerNodePipelineCommands(program);
// Order recovery (plan 038 T11): dry-run by default.
registerRecoverOrderCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // 运行期错误统一走这里：干净的一行写 stderr + 退出码 1（参数/校验错由各命令 exit 2）。
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[douyin-rec] 错误: ${msg}`);
  process.exit(1);
});
