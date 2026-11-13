import "./load-env.js";
import { createHubStarter } from "@drec/hub-compose";
import { streamPartMaxMs } from "./stream-part-duration.js";
import { zeroDiskSpoolName, zeroDiskXmlPath } from "./zero-disk-room.js";
import { zeroDiskUploadCookie } from "./zero-disk-upload-cookie.js";
import { buildLivePumpSubmitter } from "./live-pump-submitter.js";
import { runWithUploadQuota } from "./upload-quota.js";
import { Command } from "commander";
import { applyNodeDataRoot, registerNodePipelineCommands } from "./node-pipeline-commands.js";
import { NODE_COMMANDS, localRoomProbes, notifyOutboxArgs, runNodeCommandCli } from "./node-commands.js";
import { registerRecoverOrderCommands } from "./hub-recover-order-commands.js";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { ZERO_DISK_DELIVERY_ENV, effectiveStageFormat, loadConfig, parseOutputFormat, stageExt } from "@drec/core";
import { biliAccountKey } from "@drec/bilibili-api";
import { parseDanmuFlag, parseRollingUploadFlag, parseStreamUploadFlag, rejectsNoSpoolFlag } from "./cli-flags.js";
import type { OutputFormat, StageFormat } from "@drec/core";
import { RecordingSession, XmlDanmuWriter } from "@drec/manager";
import "./providers-register.js";
import { decorateRecordEvent, getEngine, platformForRoom, type DownloadEngine } from "@drec/core";
import { PollingRecorder, describeStreamIdentity } from "@drec/record-engine";
import { groupSessionsInDir, mergeSession, mergeSessions } from "@drec/post-process";
import { renderXmlToAss } from "@drec/post-process";
import { burn } from "@drec/post-process";
import { FONTS_DIR } from "@drec/post-process";
import {
  upload as biliUpload, checkBiliup, DEFAULT_COOKIES, drecRoot, rootOutputDir,
  readOutputLayout, LiveUploadReporter,
} from "@drec/app";
import { initRecorderState, noteRecorderDraining, noteRecorderSignal, setRecorderPhase } from "@drec/core";
import { type Recorder, type RecordOpts, type NotifyEvent, type Notifier } from "@drec/core";
import {
  makeNotifier, shouldSendWebhook, webhookTogglesFromEnv, resolveUploadAccountKey,
  type NotifWebhookToggles,
} from "@drec/app";
import {
  buildTaskCommand, buildCookieCommand, zeroDiskStreamMeta, APP_VERSION, syncDbPathFor,
  hubStageDir, hubLogsDir,
} from "@drec/app";
import type { HubStarter, TaskStore } from "@drec/app";
import { applyTimezoneFromDb, dbPathForDataRoot } from "@drec/app";
import { zeroDiskStreamKey } from "@drec/core";
import { recordStreamUpload, deleteHubHistory } from "@drec/orchestrator";
import { reportStreamUploadLedgerResult } from "./stream-upload-ledger-report.js";
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
  /** 边录边传开关:经 ./cli-flags.js 的 parseRollingUploadFlag 严格解析——空/未传 = 关(站点默认),未知取值报错并 exit 2,绝不回落为开。 */
  rollingUpload?: string;
  /** 直播直传开关:经 ./cli-flags.js 的 parseStreamUploadFlag 严格解析——空/未传 = 关(站点默认),未知取值报错并 exit 2,绝不回落为开;ffmpeg stdout → UPOS 分块 → 单一稿件。 */
  streamUpload?: string;
  streamUploadSize?: string;
  streamUploadSec?: string;
  streamUploadStallSec?: string;
  streamUploadRecoverSec?: string;
  streamUploadRatioAlert?: string;
  streamUploadTid?: string;
  streamUploadTag?: string;
  streamUploadPrivate?: string;
  streamUploadSpool?: string;
  /** Internal: hub-managed side node (issue #331); metadata comes from the delivered env object only. */
  zeroDiskManaged?: string;
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
  // serve 拉起子进程时用文件传 webhook(凭证不进 argv / ps);手动 CLI 仍可直接用 --discord-webhook。
  .option("--discord-webhook-file <path>", "从文件读取 Discord webhook (优先于 --discord-webhook)")
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
  .option("--stream-upload <0|1>", "直播直传: 1=ffmpeg stdout 直传 UPOS 并续同一稿件,上传确认后删本地回退文件;0=关闭(默认)")
  .option("--stream-upload-size <bytes>", "流式直传每 P 字节上界(默认对齐后的 1.5GiB)")
  .option("--stream-upload-sec <sec>", "流式直传每 P 时长阈值(秒),与 --stream-upload-size 谁先到算一 P")
  .option("--stream-upload-stall-sec <sec>", "流式直传无写入看门狗(秒;默认 120,最低 60):无写入超过该时长即封口并重连,慢速但持续的数据不会误封")
  .option("--stream-upload-recover-sec <sec>", "流式直传停滞后的自动恢复窗口(秒;默认 1200,最低 60)")
  .option("--stream-upload-ratio-alert <0-1>", "流式直传每 P 媒体时长/墙钟时长 低于该比例时告警(默认 0.85,0=关闭)")
  .option("--stream-upload-tid <tid>", "流式直传投稿分区(默认 21)")
  .option("--stream-upload-tag <tag>", "流式直传标签(逗号分隔;省略=hub 规则/hub.config 默认)")
  .option("--stream-upload-spool <full|none>", "(兼容旧参数,已固定为 full) 直播直传保留本地回退文件; none 不再生效", "full")
  .option("--zero-disk-managed <0|1>", "(内部) hub 受管侧节点的 0 落盘:元数据/账号校验只取 master 下发对象,缺失即拒绝启动")
  .option("--stream-upload-private <0|1>", "流式直传仅自己可见(省略=hub 规则/hub.config 默认,保守为 1)")
  .option("--output-format <fmt>", "节点侧输出格式 original|mp4|mkv: 分段封口后原地 remux 成所选容器、校验通过后删原文件 (默认 original=不转)")
  .option("--task-id <n>", "所属任务 id(serve 拉起时传入;封口转换入队行据此归属任务,失败告警按任务显示)")
  .option("--config <path>", "YAML 配置文件 (命令行选项优先覆盖)")
  .action(async (o: RecordCliOpts) => {
    const cfg = loadConfig(o.config);
    // Reject a lone `--stream-upload-spool none` too: it used to be silently ignored, so the
    // operator could believe the flag took effect while the pump still kept a local fallback.
    if (rejectsNoSpoolFlag(o.streamUploadSpool)) {
      console.error("[rec] --stream-upload-spool none 已禁用:直播直传必须保留本地回退文件");
      process.exit(2);
    }
    // 上传开关严格解析(H-974):未知取值(如手误 enble)必须报错退出,不能沿用宽粒度解析
    // 的「未知=开」旧行为悄悄打开上传路径。空值/未传 = 关。先 rolling 后 stream,两个都非法
    // 时只报第一个;报错在互斥检查/initRecorderState/任何网络调用之前。
    const rollingParsed = parseRollingUploadFlag(o.rollingUpload);
    if (!rollingParsed.ok) {
      console.error(`[rec] ${rollingParsed.error}`);
      process.exit(2);
    }
    const streamParsed = parseStreamUploadFlag(o.streamUpload);
    if (!streamParsed.ok) {
      console.error(`[rec] ${streamParsed.error}`);
      process.exit(2);
    }
    const rollingEnabled = rollingParsed.value;
    const streamUploadEnabled = streamParsed.value;

    // 平台驱动默认:命令行 --engine > 兼容别名 --recorder > config > 平台默认引擎。
    // 旧 config.recorder 可能是已废弃的录制器 provider 名(非引擎 id)→ getEngine 返 undefined,
    // 回落平台默认引擎(下面构造时兜底)。
    const platform = platformForRoom(o.room);
    const engineId = o.engine || o.recorder || cfg.recorder || platform.defaultEngine;
    // 弹幕退化为开关:on/off(来源由平台 connectDanmu 提供);config.danmu 旧值非 none 即视为开。
    const danmuEnabled = parseDanmuFlag(o.danmu ?? cfg.danmu);

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
      // Node-local layout switch (issue #336); read once at process start so a running session never changes dir.
      outputLayout: readOutputLayout(),
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

    const gopts = program.opts() as { discordWebhook?: string; discordWebhookFile?: string };
    const webhook = (gopts.discordWebhookFile ? readFileSync(gopts.discordWebhookFile, "utf-8").trim() || undefined : undefined)
      ?? gopts.discordWebhook ?? cfg.discordWebhook ?? process.env.DISCORD_WEBHOOK;
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
    // 关闭时 undefined → session 完全不启用,行为与改动前一致。开关 0/1/on/off/true/false(与 task-input
    // 同套假值),已在 action 开头用 parseRollingUploadFlag 严格解析:未知取值直接报错退出,不再当「开」。
    let makeRolling: (() => import("@drec/manager").RollingUploadHook) | undefined;
    if (rollingEnabled) {
      const { makeRollingUploadHookFactory, uploadOwnerForTask, enqueueHubOwnedSkip, rootHubDir, resolveDbPath, TaskStore } = await import("@drec/app");
      const { rollingQueueModeEnabled, shouldDecideUploadOwner, masterOwnedWithoutRule, enabledHubRuleForTask } = await import("@drec/app");
      const slug = platform.extractRoomSlug(roomToUrl(o.room));
      // Production record is spawned by TaskManager; wire the same hub-owner decision as task run,
      // otherwise hub-bound rooms would upload on the node AND on the master (double archive).
      // Only a hub master takes ownership here: a machine that has enabled rule files but runs serve
      // without --hub has no orchestrator to upload the skipped parts, and must keep uploading on the
      // node (the serve process marks hub mode with DOUYIN_REC_HUB_MASTER=1).
      const hubMaster = process.env.DOUYIN_REC_HUB_MASTER === "1";
      let uploadOwner: (() => ReturnType<typeof uploadOwnerForTask>) | undefined;
      let enqueueHubSkipped: ((input: { file: string; index: number; seq?: number; streamKey: string; title?: string; expectedDurationSec?: number; confirmedAt?: number }) => boolean) | undefined;
      if (o.taskId !== undefined && /^\d+$/.test(o.taskId)) {
        const db = new TaskStore(resolveDbPath());
        try {
          const task = db.listTasks().find((t) => t.id === Number(o.taskId));
          if (task && shouldDecideUploadOwner(task, hubMaster)) {
            uploadOwner = () => uploadOwnerForTask(task, rootHubDir());
            enqueueHubSkipped = (info) => enqueueHubOwnedSkip({ ...info, taskId: task.id });
            // A hub-managed task whose rule is gone would record parts nobody ever uploads: say so.
            // (Worker nodes legitimately have no local rule files, hence the hub-master scope.)
            if (masterOwnedWithoutRule(uploadOwnerForTask(task, rootHubDir()), enabledHubRuleForTask(task, rootHubDir()) !== undefined, hubMaster)) {
              console.error("[rec] ⚠️ hub-owned 房间没有启用中的规则:本场只写 skipped 行,没有 uploader(task=" + String(task.id) + ")");
            }
          }
        } finally { db.close(); }
      }
      makeRolling = makeRollingUploadHookFactory({
        enabled: true,
        platform: platform.id,
        roomSlug: slug,
        // Plan 046 PR6 (方案 A): settings switch, default off => this path stays unchanged.
        queueMode: rollingQueueModeEnabled(),
        ...(o.taskId !== undefined && /^\d+$/.test(o.taskId) ? { taskId: Number(o.taskId) } : {}),
        ...(uploadOwner ? { uploadOwner } : {}),
        ...(enqueueHubSkipped ? { enqueueHubSkipped } : {}),
        log: (m: string) => console.log(m),
        notify: (message: string) => { void notifier.notify({ kind: "error", stage: "边录边传", message }).catch(() => {}); },
      });
      console.log(`[rec] 边录边传已开启:每封口一段上传后删该段源(room=${slug})`);
    }
    // streaming upload replaces the file-based recorder; running both would pull the same
    // stream twice and upload a duplicate archive, so it must be mutually exclusive.
    if (streamUploadEnabled && rollingEnabled) {
      console.error("[rec] --stream-upload 与 --rolling-upload 互斥,请只开一个");
      process.exit(2);
    }
    // Process state file (plans/044): only a child launched by serve (has --task-id) writes one. The writer is
    // started before any mode-specific work, so the file exists while the child is still waiting for a broadcast.
    // The exit hook covers every exit path except SIGKILL; write failures are logged once and never fatal.
    if (o.taskId !== undefined && /^\d+$/.test(o.taskId)) {
      initRecorderState({
        root: drecRoot(),
        taskId: Number(o.taskId),
        platform: platform.id,
        roomSlug: platform.extractRoomSlug(roomToUrl(o.room)),
        mode: streamUploadEnabled ? "live" : rollingEnabled ? "rolling" : "file",
      }).installExitHook(process);
    }
    if (streamUploadEnabled) {
      // 直连新包(不再经 processors re-export):生产路径的依赖要明确,否则"换实现"
      // 看起来像改 processors,容易连带碰到后处理插件层。
      const { runLivePump, alignFileSize, DEFAULT_SEGMENT_CAP, DEFAULT_STALL_TIMEOUT_MS, DEFAULT_RECOVERY_WINDOW_MS, DEFAULT_MEDIA_WALL_ALERT_RATIO, readLivePumpState, livePumpStatePath, spoolPathsToKeep, archivedSpoolPathsToKeep, spoolSweepSafe } = await import("@drec/zero-upload");
      const {
        rootBiliupCookies, sweepOrphanSpools, resolveStreamUploadMeta,
        resolveStreamUploadTitle, resolveStreamPartTitle,
        zeroDiskNodePreflight, writeZeroDiskStatus, createZeroDiskReporter, makeNodeSubmitGate,
        resolveZeroDiskPumpDirs,
      } = await import("@drec/app");
      // Hub-rule metadata is the same single source as rolling upload (rule upload >
      // hub.config uploadDefaults > built-in defaults). Explicit stream-upload flags still win
      // because they only serve manual debugging.
      const roomSlug = platform.extractRoomSlug(roomToUrl(o.room));
      // Issue #360: with the room layout on, spool/state/xml live in the room directory and the
      // spool file carries the anchor name. The layout is read once per process; a running pump
      // never changes directory underneath itself. Legacy stays at the output root.
      const pumpLayout = readOutputLayout();
      const pumpAnchor = o.name?.trim() || "";
      // Directory resolution is shared with the serve-side live gate (it must look at the same
      // state file the child recovers from). The room directory is resolved even in legacy
      // layout: the rollback check below inspects the room-dir state, not the root one.
      // Sticky: a broadcast that already has a legacy state keeps using the root, so an upgrade
      // never moves a live archive or its unconfirmed WAL. Nothing is migrated.
      const { pumpRoom, roomDir, pumpFilesDir } = resolveZeroDiskPumpDirs({
        platform, rawRoom: o.room, outDir: opts.outDir, anchorName: pumpAnchor, layout: pumpLayout,
      });
      if (pumpFilesDir !== opts.outDir) mkdirSync(pumpFilesDir, { recursive: true });
      // A rollback to the legacy layout must not strand a room-dir WAL: nothing would ever
      // re-upload those unconfirmed parts. Alert (and keep recording into the root, where the
      // legacy layout belongs) so a human can reconcile instead of silently losing the part.
      if (pumpLayout !== "room" && roomDir !== opts.outDir) {
        const roomStatePath = livePumpStatePath(roomDir, pumpRoom);
        const roomState = readLivePumpState(roomStatePath);
        if (roomState && (roomState.pending || roomState.parts.some((x) => !x?.confirmed))) {
          const msg = `直播直传房间目录里还有未确认分 P,但当前是 legacy 布局,不会自动续传: ${roomStatePath}`;
          console.error(`[直播直传] ⚠️ ${msg}`);
          await notifier.notify({ kind: "error", stage: "直播直传", message: msg }).catch(() => {});
        }
      }

      // Hub-managed side node (issue #331): the master-delivered object is the ONLY source of upload
      // metadata and the account to verify. The node's rule directory is empty, so reading it would
      // silently fall back to defaults (private visibility, default title). Refuse instead.
      const managed = o.zeroDiskManaged === "1";
      let delivery: import("@drec/core").ZeroDiskDelivery | undefined;
      let managedCookies: string | undefined;
      if (managed) {
        const pre = zeroDiskNodePreflight(process.env[ZERO_DISK_DELIVERY_ENV]);
        if (!pre.ok) {
          writeZeroDiskStatus({ platform: platform.id, roomSlug, state: "refused", code: pre.refusal.code, message: pre.refusal.message, parts: 0 });
          const msg = `直播直传拒绝启动 [${pre.refusal.code}]: ${pre.refusal.message}`;
          console.error(`[直播直传] ${msg}`);
          await notifier.notify({ kind: "error", stage: "直播直传", message: msg }).catch(() => {});
          process.exit(2);
        }
        delivery = pre.delivery;
        managedCookies = pre.cookiesPath;
        console.log(`[直播直传] 节点预检通过(上传登录来源=${pre.credentialSource},账号与 master 配置一致)`);
      }
      // Explicit stream-upload flags only serve manual debugging; a managed run ignores them.
      const manual: Pick<RecordCliOpts, "streamUploadTid" | "streamUploadTag" | "streamUploadPrivate"> = delivery ? {} : o;
      const streamMeta = zeroDiskStreamMeta(delivery, resolveStreamUploadMeta(platform.id, roomSlug));
      // Display-only timeline. It is independent of the managed receipt reporter below.
      const liveReporter = new LiveUploadReporter({ platform: platform.id, roomSlug });
      const metaOverride = delivery ? { meta: delivery.meta } : {};
      // The stored task name is only a fallback; the live stream usually exposes the real
      // anchor. Both the XML metadata and `{name}` should use the real anchor once known.
      let anchorName = o.name?.trim() || roomSlug;
      // Explicit flag (manual debugging) > per-room rule / master delivery (MiB) > built-in default.
      const sizeCap = alignFileSize(o.streamUploadSize !== undefined
        ? Number(o.streamUploadSize)
        : streamMeta.partSizeMiB ? streamMeta.partSizeMiB * 1024 * 1024 : DEFAULT_SEGMENT_CAP);
      const uploadCookies = managedCookies ?? zeroDiskUploadCookie(process.env, rootBiliupCookies());
      // Status + receipt for the master (managed only); one receipt id per process run.
      const reporter = delivery ? createZeroDiskReporter({ platform: platform.id, roomSlug }) : null;
      reporter?.running();
      // Latched on the first successful acquisition so templates use the real broadcast start,
      // not the process start (a task may sit in "waiting for stream" for hours).
      let streamStartMs = Date.now();
      let streamStarted = false;
      const secondsSetting = (raw: string | undefined, fallback: number): number => {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.max(60_000, Math.round(n * 1000)) : fallback;
      };
      const stallTimeoutMs = secondsSetting(o.streamUploadStallSec, DEFAULT_STALL_TIMEOUT_MS);
      const recoverWindowMs = secondsSetting(o.streamUploadRecoverSec, DEFAULT_RECOVERY_WINDOW_MS);
      const ratioRaw = Number(o.streamUploadRatioAlert);
      const mediaWallAlertRatio = Number.isFinite(ratioRaw) && ratioRaw >= 0 && ratioRaw <= 1
        ? ratioRaw
        : DEFAULT_MEDIA_WALL_ALERT_RATIO;
      // A resumed session keeps the archive identity from its state file; only a fresh session
      // uses this title. `--name` is the anchor/output name, not a title override, so hub title
      // templates remain effective for named tasks.
      const streamTitle = resolveStreamUploadTitle({
        platform: platform.id,
        roomSlug,
        anchorName,
        startMs: streamStartMs,
        ...metaOverride,
      });
      console.log(
        `[rec] 直播直传已开启:room=${o.room} sizeCap=${sizeCap} ` +
        `sec=${o.streamUploadSec ?? (Number(o.segment ?? 0) > 0 ? `${o.segment}(--segment)` : "字节兜底")} ` +
        `stall=${stallTimeoutMs / 1000}s recover=${recoverWindowMs / 1000}s ` +
        `tid=${manual.streamUploadTid ?? streamMeta.tid}${managed ? " (master 下发)" : ""}`,
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
      // Per-run file name (issue #329): fixed only once the danmu actually starts.
      let xmlPath = "";
      const writer = danmuSource ? new XmlDanmuWriter({ log: (m) => console.warn(`[直播直传] ⚠️ ${m}`) }) : null;
      let writerOpened = false;
      const danmu = danmuSource && writer ? {
        get xmlPath(): string { return xmlPath; },
        start: async (): Promise<void> => {
          // Anchor to the wall clock at connect time: parts are sealed by byte/duration, so a
          // single session-level axis is the only stable reference for burn/part slicing.
          const startMs = Date.now();
          // A same-second reconnect would otherwise truncate the previous run's danmu (the writer
          // opens with truncate). Never reuse an existing xml name.
          const xmlBase = zeroDiskXmlPath(pumpFilesDir, platform.extractRoomSlug(roomToUrl(o.room)), startMs, undefined, pumpLayout === "room" ? pumpAnchor : undefined);
          xmlPath = xmlBase;
          if (pumpLayout === "room") {
            for (let n = 1; existsSync(xmlPath); n++) xmlPath = xmlBase.replace(/\.live\.xml$/, `-${n}.live.xml`);
          }
          writer.open(xmlPath, { anchorName, roomId: platform.extractRoomSlug(roomToUrl(o.room)), videoStartMs: startMs });
          writerOpened = true;
          await danmuSource.start(roomToUrl(o.room), {
            quality: (o.quality ?? cfg.quality ?? platform.defaultQuality) as RecordOpts["quality"],
            cookies: o.cookies,
            outDir: opts.outDir,
            segmentSec: 0,
          }, (m) => writer.add(m), (msg) => console.error(`[直播直传] ⚠️ 弹幕: ${msg}`));
        },
        stop: async (): Promise<void> => {
          await danmuSource.stop().catch(() => {});
          if (writerOpened) writer.close();
        },
      } : undefined;
      if (danmuSource) console.log(`[rec] 弹幕落盘(唯一落盘产物): ${pumpFilesDir}/<开播时间>.live.xml`);
      // Remove spools left by a pump killed mid-part. They never reached the state file, so
      // nothing else would ever delete them. Only old, unreferenced files are touched.
      // The keep-set is `spoolPathsToKeep` (single source of truth next to the state shape):
      // it covers `parts` *and* `pending`. `pending` is the WAL of an upload whose outcome was
      // never persisted, and recovery re-uploads that whole file — listing only `parts` would
      // delete the last copy of an interrupted part (real data loss, found by review #280).
      const st = readLivePumpState(livePumpStatePath(pumpFilesDir, pumpRoom));
      // One sweep over the root, with a keep-set built from EVERY root state. Sweeping the root
      // with only this room's state (the old shape) deleted another room's unconfirmed spool:
      // upload backoff can exceed the 10-minute orphan grace, so those files are not orphans.
      // A state that cannot be read means the keep-set is unknown -> skip entirely.
      const rootKeep: string[] = [];
      let rootSafe = true;
      try {
        for (const f of readdirSync(opts.outDir)) {
          if (!/^live-pump-.+\.state\.json(?:\..*)?$/.test(f)) continue;
          if (f.includes(".tmp.")) continue; // a crash leftover, not a state
          const st2 = readLivePumpState(join(opts.outDir, f));
          if (!st2) { rootSafe = false; break; }
          rootKeep.push(...spoolPathsToKeep(st2));
        }
      } catch (e) {
        // Missing dir = nothing to sweep; any other error means we cannot prove the keep-set.
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") rootSafe = false;
      }
      if (rootSafe) {
        sweepOrphanSpools({
          spoolDir: opts.outDir,
          knownSpoolPaths: [...rootKeep, ...archivedSpoolPathsToKeep(opts.outDir, pumpRoom)],
          log: (m) => console.log(m),
        });
      } else {
        console.log("[直播直传] 根目录存在无法读取的旧状态,跳过孤儿 spool 清扫(避免误删其引用的暂存文件)");
      }
      if (pumpFilesDir !== opts.outDir) {
        // The room dir is swept separately: rootKeep only protects root spools.
        if (spoolSweepSafe(pumpFilesDir, pumpRoom)) {
          sweepOrphanSpools({
            spoolDir: pumpFilesDir,
            knownSpoolPaths: [...spoolPathsToKeep(st), ...archivedSpoolPathsToKeep(pumpFilesDir, pumpRoom)],
            log: (m) => console.log(m),
          });
        } else {
          console.log("[直播直传] 房间目录存在无法读取的旧状态,跳过该目录清扫(避免误删其引用的暂存文件)");
        }
      }
      const abort = new AbortController();
      const onSig = (sig: string): void => {
        console.log(`[直播直传] 收到 ${sig},停止录制并中止当前分 P`);
        noteRecorderSignal(sig);
        abort.abort();
      };
      process.on("SIGINT", () => onSig("SIGINT"));
      process.on("SIGTERM", () => onSig("SIGTERM"));
      // Window-end drain (SIGUSR2). Registered *before* the pump starts so a window-end signal
      // always finds a handler: Node's default for an unhandled SIGUSR2 is immediate process
      // death (measured: exit 159), which cuts the in-flight part mid-upload. It would also be
      // reported as a clean exit: `stopGraceful` marks the child `expected` *before* sending the
      // signal, so the task log would claim "直播自然收播，排空完成" for a broadcast that was
      // never drained.
      const drain = new AbortController();
      process.on("SIGUSR2", () => {
        if (drain.signal.aborted) return; // the daemon re-sends every tick; idempotent
        noteRecorderDraining();
        drain.abort();
      });
      // Stage 2b-2c: metadata-only publish for the parts this pump already uploaded. Off unless
      // DREC_LIVE_PUMP_DRIVER=1, so the legacy in-process submit stays the default path.
      const pumpSubmitter = buildLivePumpSubmitter({
        cookiesPath: uploadCookies,
        spoolDir: pumpFilesDir,
        pumpRoom,
        log: console.log,
      });
      const run = runLivePump({
        ...(pumpSubmitter ? { submitter: pumpSubmitter } : {}),
        cookiesPath: uploadCookies,
        room: pumpRoom,
        fetch: async (r, q) => {
          const s = await platform.getStream(r, q);
          if (s.owner?.trim()) anchorName = s.owner.trim();
          // Zero-disk path bypasses PollingRecorder; log identity here so both paths are comparable.
          if (s.living && s.url) console.log(`[session-id] ${describeStreamIdentity(s)}`);
          if (s.living && s.url && !streamStarted) {
            streamStartMs = Date.now();
            streamStarted = true;
          }
          return {
            living: s.living,
            ...(s.url ? { url: s.url } : {}),
            ...(s.headers ? { headers: s.headers } : {}),
            ...(s.title ? { title: s.title } : {}),
            ...(s.owner ? { owner: s.owner } : {}),
          };
        },
        quality: (o.quality ?? cfg.quality ?? platform.defaultQuality) as RecordOpts["quality"],
        spoolDir: pumpFilesDir,
        // New sessions use a time-first name with a `.live` suffix. The room directory already
        // carries platform/room identity; the legacy root also gets the anchor/room prefix.
        spoolName: (seg: number) => {
          const head = pumpAnchor || roomSlug;
          let name = zeroDiskSpoolName(head, streamStartMs, seg);
          // A restart in the same second would otherwise reuse a name the state may reference.
          for (let n = 1; existsSync(join(pumpFilesDir, name)); n++) {
            name = zeroDiskSpoolName(head, streamStartMs, seg, undefined, n);
          }
          return name;
        },
        title: streamTitle,
        titleForLive: (liveTitle) => resolveStreamUploadTitle({
          platform: platform.id,
          roomSlug,
          anchorName,
          startMs: streamStartMs,
          liveTitle,
          ...metaOverride,
        }),
        partTitle: (partIndex, liveTitle) => resolveStreamPartTitle({
          platform: platform.id,
          roomSlug,
          anchorName,
          startMs: streamStartMs,
          partIndex,
          ...(liveTitle ? { liveTitle } : {}),
          ...metaOverride,
        }),
        tid: Number(manual.streamUploadTid ?? streamMeta.tid),
        tag: manual.streamUploadTag ?? streamMeta.tag,
        ...(streamMeta.desc ? { desc: streamMeta.desc } : {}),
        ...(streamMeta.seasonSectionId ? { seasonSectionId: streamMeta.seasonSectionId } : {}),
        private: manual.streamUploadPrivate === undefined ? streamMeta.private : manual.streamUploadPrivate !== "0",
        sizeCap,
        maxMs: streamPartMaxMs(o.streamUploadSec, o.segment),
        stallTimeoutMs,
        recoverWindowMs,
        mediaWallAlertRatio,
        maxSegments: 0,
        submit: true,
        spoolMode: "full",
        signal: abort.signal,
        drainSignal: drain.signal,
        // Wait in-process for the next broadcast instead of exiting (issue #308).
        waitForBroadcast: true,
        onPhase: (p) => setRecorderPhase(p),
        danmu,
        log: (m) => console.log(m),
        onAlert: (message) => { void notifier.notify({ kind: "error", stage: "直播直传", message }).catch(() => {}); },
        reporter: liveReporter,
        // Managed nodes share the account's submission window with the node's other uploads and
        // report part progress to the master console (issue #331).
        ...(delivery ? {
          submitGate: makeNodeSubmitGate({ cookiesPath: uploadCookies, log: (m) => console.log(m) }),
          onPartConfirmed: (info: { count: number; bvid?: string }) => reporter?.partConfirmed(info),
        } : {}),
      }).then(async (res) => {
        console.log(`[直播直传] ${JSON.stringify(res)}`);
        // Record the upload outcome in the hub ledger. A zero-disk run leaves no recording
        // files for the pipeline to scan, so without this the room would never show an outcome.
        // Best effort: the archive already exists, so a ledger failure must not fail the run.
        if (reporter) {
          // Managed side node: the master owns the ledger. Persist an immutable receipt the master
          // polls (`_zero-disk-report`); this node's own ledger is never written.
          const fin = reporter.finish({ ok: res.ok, ...(res.bvid ? { bvid: res.bvid } : {}), ...(res.error ? { error: res.error } : {}), segments: res.segments.filter((x) => !x.uploadError).length, ...(res.lostParts ? { lostParts: res.lostParts } : {}), ...(res.unknownParts ? { unknownParts: res.unknownParts } : {}) });
          if (fin.receiptError) {
            // The archive exists but the master cannot learn about it: say so loudly.
            console.error(`[直播直传] ⚠️ ${fin.receiptError}`);
            await notifier.notify({ kind: "error", stage: "直播直传", message: fin.receiptError }).catch(() => {});
          } else if (fin.receiptWritten) {
            console.log(`[直播直传] 回执已写入,等待 master 拉取并记台账: ${res.bvid}`);
          }
        } else if (res.ok && res.bvid) {
          if (res.lostParts) console.log(`[直播直传] ⚠️ 本场有 ${res.lostParts} 个分 P 在停止时丢失,其余已入稿,照常记台账`);
          const r = recordStreamUpload({
            syncDbPath: syncDbPathFor(dbPathForDataRoot(process.env.DOUYIN_REC_ROOT ?? process.cwd())),
            // Own key namespace + real start time, so a regular recording of the same room and day is
            // never mistaken for this job and skipped (issue #324).
            streamKey: zeroDiskStreamKey(platform.id, roomSlug, streamStartMs),
            bvid: res.bvid,
            // Only parts that reached the archive: a segment kept with an upload error is not a part.
            parts: res.segments.filter((x) => !x.uploadError).length,
            startMs: streamStartMs,
          });
          // 收尾台账结果统一出口(issue #428):失败除日志外走告警通道(与上方受管分支的
          // receiptError 同款)——稿件已上传但台账没记,房间看不到这场结果,不能只 console.log。
          // 收尾后马上 process.exit,notify 必须 await,否则 webhook 被截断。
          await reportStreamUploadLedgerResult(r, {
            log: (m) => console.log(m),
            notify: (message) => notifier.notify({ kind: "error", stage: "直播直传", message }),
          });
        }
        // `ok:true` covers three endings: parts delivered, `idle` and `no-stream`. With
        // `waitForBroadcast` the pump never gives up waiting on its own (issue #308); `idle` means
        // no part this run (stopped while waiting, or the room dropped right after going live),
        // which is a normal ending and exits 0. Exiting non-zero for it made TaskManager treat an
        // idle task as a crash and restart it in a loop. `no-stream` (gave up, non-waiting
        // callers only) stays a failure as a backstop (review #280 P1).
        // An `ok:false` run may already have delivered parts, so only its error text is logged.
        const clean = res.ok && res.outcome !== "no-stream";
        const outcome = clean ? "finished" : abort.signal.aborted || drain.signal.aborted ? "stopped" : "failed";
        liveReporter.event({ at: Date.now(), kind: "run_end", outcome, ...(res.error ? { message: res.error } : {}) });
        if (res.ok && res.outcome === "idle") {
          console.log("[直播直传] 本次未录到分 P(等待中被停止,或开播后立即断流),正常退出");
        } else if (res.ok && res.outcome === "no-stream") {
          console.error("[直播直传] 本场没有上传任何分 P(取不到流),按失败退出并交由调度重试");
        } else if (!res.ok && res.error) {
          console.error(`[直播直传] 本场以失败收尾: ${res.error}`);
        }
        process.exit(clean ? 0 : 1);
      }).catch((e) => {
        console.error(`[直播直传] 失败: ${(e as Error).message}`);
        liveReporter.event({ at: Date.now(), kind: "run_end", outcome: "failed", message: (e as Error).message });
        reporter?.failed((e as Error).message);
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
      noteRecorderSignal(sig);
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
      noteRecorderDraining();
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
      const result = await runWithUploadQuota(
        { cookiesPath: cookies, log: (m) => process.stderr.write(`[upos] ${m}\n`) },
        async () => {
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
          return { ok: true, bvid: r.bvid, aid: r.aid, parts };
        },
      );
      process.stdout.write(JSON.stringify(result) + "\n");
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
  .option("--size <bytes>", `分段字节上界(默认 ${DEFAULT_SEGMENT_CAP} = 对齐后的 1.5GiB;须 10MiB 对齐)`, String(DEFAULT_SEGMENT_CAP))
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
      process.stderr.write(`[直播直传] size ${o.size} 未按 10MiB 对齐 → 用 ${sizeCap}\n`);
    }
    if (sizeCap !== DEFAULT_SEGMENT_CAP && o.size === String(DEFAULT_SEGMENT_CAP)) {
      // 走到这里说明用户手改过 --size;提示真实生效值,避免「我设了 1.5GiB 怎么变成 1540MiB」。
      process.stderr.write(`[直播直传] 默认上界已按 10MiB 对齐为 ${DEFAULT_SEGMENT_CAP}(1.5GiB=153.6×10MiB,不对齐)\n`);
    }
    const spoolDir = o.spoolDir ?? `${tmpdir()}/live-pump`;
    const maxSegments = Math.max(1, Number(o.segments));
    const title = o.title ?? `测试-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
    // Production hands the pump a normalized room id, and the harness used to hand it the full URL.
    // That is the one difference that made every fresh fetch answer 10011 while probe (which
    // normalizes) still resolved the stream.
    const pumpRoom = platform.extractRoomSlug(roomToUrl(room));
    // Same opt-in as the production record path: the manual harness must be able to exercise it.
    const pumpSubmitter = buildLivePumpSubmitter({
      cookiesPath: o.cookies,
      spoolDir,
      pumpRoom,
      log: console.log,
    });
    const res = await runLivePump({
      ...(pumpSubmitter ? { submitter: pumpSubmitter } : {}),
      cookiesPath: o.cookies,
      room: pumpRoom,
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
    process.stderr.write(`[直播直传] 状态保留在 ${res.statePath}(确认过的 spool 已清理)\n`);
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
  .option("--slot-wait <sec>", "等待本机上传槽位的上限秒数（默认 600；0=只检查一次）", "600")
  .action(async (o: { video: string; title: string; tag: string; tid: string; public: boolean; desc?: string; cookiesFile: string; slotWait: string }) => {
    // 预检失败直接 exit 2，不发通知（在 try 之外）
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
      await toggledNotifier(webhookOf()).notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
    } catch (e) {
      await toggledNotifier(webhookOf()).notify({ kind: "error", stage: "upload", message: (e as Error).message });
      throw e;
    }
  });

// ─── Hub starter: 多节点同步编排（cli L5 注入到 app L4，避免循环依赖）──────────────
// app 不直接依赖 @drec/orchestrator（orchestrator 依赖 app），由 cli 作为 L5 入口注入。
// web API 在 hub 规则/worker 变更后立即触发一次任务同步(不等 60s 周期 tick)。
// Hub starter is assembled by @drec/hub-compose; the CLI only injects what it still owns.
const hubStarter: HubStarter = createHubStarter({
  // The probe implementation stays in the CLI (it owns state files + /proc fallbacks).
  localRoomProbes: (dataRoot, _probeDeps, fallback) => localRoomProbes(dataRoot, undefined, fallback),
  masterUploadAccountKey,
});

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
  .option("--host <host>", "监听地址（默认回环；all=所有网卡；远程访问需配置共享密钥）")
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
      fleetCommands: NODE_COMMANDS,
      // Ledger deletion lives in orchestrator (it owns the schema); app/web only calls it through here.
      deleteHubHistory: (syncDbPath, roomKey) =>
        deleteHubHistory({ syncDbPath, roomKey, stageDir: hubStageDir(), logsDir: hubLogsDir() }),
    });
  });

program.addCommand(taskCmd);

// ─── cookie 子命令组：管理全局抖音账号 cookie（所有任务共享）────────────────────
program.addCommand(buildCookieCommand());


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

// ─── _inventory <dataRoot>（隐藏子命令，供多节点编排 master 通过 SSH 调用）──────────
// master 通过 ssh 在 slave 上执行 `node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>`。
// slave 扫描自己的 recordings 目录，输出 JSON { recordings: NodeRecording[] } 到 stdout。
// 注意：此命令在 slave（VPS）上运行，不在 master 本地运行，也不是用户可见子命令。
program
  .command("_inventory <dataRoot>", { hidden: true })
  .description("(内部) 扫描 <dataRoot>/recordings，输出 JSON 清单（供 master ssh 调用）")
  .action(async (dataRoot: string) => {
    await runNodeCommandCli("inventory", dataRoot, []);
  });

// ─── _disk <dataRoot>（隐藏子命令，供 master 通过 SSH 调用）──────────────────────
// 输出该节点录制数据根所在卷的剩余空间(GB)。master 侧磁盘看门狗用 —— 不依赖 worker
// 自身 webhook 是否配置(worker 常不配 DISCORD_WEBHOOK,告警发不出去)。
program
  .command("_disk <dataRoot>", { hidden: true })
  .description("(内部) 输出数据根剩余空间 GB(供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    await runNodeCommandCli("disk", dataRoot, []);
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

// (internal) Join the fleet long connection (plans/042): the master writes this node's agent config
// (controller URL + node id + token) over ssh. A running `task serve` picks it up within a minute.
// The JSON payload is read from stdin so the token never shows up in argv / `ps`; it is never echoed back.
program
  .command("_fleet-join <dataRoot>", { hidden: true })
  .description("(内部) 从 stdin 写入节点长连接配置 config/fleet.json(供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    const { writeFleetConfig } = await import("@drec/app");
    try {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const cfg = writeFleetConfig(join(dataRoot, "config", "fleet.json"), JSON.parse(Buffer.concat(chunks).toString("utf8")));
      process.stdout.write(JSON.stringify({ ok: true, nodeId: cfg.nodeId, controllerUrl: cfg.controllerUrl }) + "\n");
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      process.stdout.write(JSON.stringify({ ok: false, error }) + "\n");
      // Also on stderr: the master's ssh runner reports stderr when the exit code is non-zero.
      process.stderr.write(`_fleet-join: ${error}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("_tasks <dataRoot>", { hidden: true })
  .description("(内部) 输出节点任务清单 JSON(供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    await runNodeCommandCli("tasks", dataRoot, []);
  });

// ─── _apply-tasks <dataRoot> <base64>（隐藏子命令，供 master 通过 SSH 调用）────────
// base64 = JSON { desired: RemoteTaskSpec[] }。按 (platform, roomSlug) 对账:
// 收编/新建期望任务、两阶段删除不再期望的受管任务。cookies 只走可信 ssh/本地通道。
program
  .command("_apply-tasks <dataRoot> <base64>", { hidden: true })
  .description("(内部) 应用 master 下发的期望任务(供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    await runNodeCommandCli("apply-tasks", dataRoot, [b64]);
  });

// (内部) 应用 master 下发的平台登录态(issue #563)。空值不删:下发的 payload 里没有的平台一律不碰。
program
  .command("_apply-cookies <dataRoot> <base64>", { hidden: true })
  .description("(内部) 应用 master 下发的平台登录态(供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    await runNodeCommandCli("apply-cookies", dataRoot, [b64]);
  });

// (内部) 读本节点某任务的日志尾巴(F3):master 在 fleet 模式下代查节点日志,不必登节点看网页。
// 日志在 serve 进程的内存环形缓冲里,短命 CLI 进程读不到 → 转问本机 serve(与 _apply-tasks 同一手法)。
// 只读:serve 未起/任务不存在都返回 {lines:[],error} 且**退出码 0**,可观测性不能反过来打断调用方。
program
  .command("_task-logs <dataRoot> <taskId> <lines>", { hidden: true })
  .description("(内部) 输出某任务最近 n 行日志 JSON(供 master ssh 代查)")
  .action(async (dataRoot: string, taskIdRaw: string, linesRaw: string) => {
    await runNodeCommandCli("task-logs", dataRoot, [taskIdRaw, linesRaw]);
  });

// (内部) 节点状态回执(T16):master 想知道「这台节点应用了哪一版期望、跑的是哪个 bundle」。
// 输出 {appVersion, appliedVersion, appliedAt, taskCount, managedCount};没有快照(从未同步过)→ 字段为 null。
// 只读、不碰任务、不写盘 —— 旧 bundle 没有本命令时,master 侧按「unknown」处理(不报错)。
program
  .command("_node-status <dataRoot>", { hidden: true })
  .description("(内部) 输出节点应用回执 JSON(appVersion/appliedVersion/appliedAt/任务数;供 master ssh 调用)")
  .action(async (dataRoot: string) => {
    await runNodeCommandCli("node-status", dataRoot, []);
  });

// (内部) 处理任务表人工清理(plans/036 §2.3):done/cancelled 超 7 天删;`--purge-failed` 额外删 failed。
// uncertain 永不在此删(须先在任务表里 ack);库不存在 → 0,不创建文件。输出 {deleted}。
program
  .command("_notify-outbox <dataRoot>", { hidden: true })
  .option("--after <id>", "只取 id 大于该游标的事件")
  .option("--limit <n>", "本次最多返回多少条(默认 200)")
  .option("--ack <ids>", "逗号分隔的事件 id,读取后一并确认")
  .action(async (dataRoot: string, o: { after?: string; limit?: string; ack?: string }) => {
    await runNodeCommandCli("notify-outbox", dataRoot, notifyOutboxArgs(o));
  });

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
    await runNodeCommandCli("enqueue", dataRoot, [b64]);
  });

// (内部) 处理任务回执(plans/036 §2.4 / T9a):请求 = base64(jobId 字符串数组);输出 {receipts: ProcessReceipt[]}。
// 库不存在 / 未知 jobId → 不出现在 receipts 里。
program
  .command("_proc-status <dataRoot> <base64>", { hidden: true })
  .description("(内部) 查询处理任务回执(供 master ssh 调用)")
  .action(async (dataRoot: string, b64: string) => {
    await runNodeCommandCli("proc-status", dataRoot, [b64]);
  });

// (internal) Cancel processing jobs (plans/038): pending rows are cancelled directly; running rows are closed out by the runner after verification.
program
  .command("_proc-cancel <dataRoot> <base64>", { hidden: true })
  .description("(internal) cancel processing jobs (called by the master over ssh)")
  .action(async (dataRoot: string, b64: string) => {
    await runNodeCommandCli("proc-cancel", dataRoot, [b64]);
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
