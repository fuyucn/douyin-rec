/**
 * app/cli-task.ts — `task` command group. Stateful app layer wiring app → core.
 *
 * Commands: add / list / remove / run.
 *   - add/list/remove: pure CRUD over TaskStore (sqlite).
 *   - run: loads a task, builds a core RecordingSession (recorder + danmu +
 *     notifier), sets status 'running', records immediately until SIGINT/SIGTERM.
 *
 * NOTE: scheduleStart/scheduleEnd are STORED but NOT acted on here — automatic
 * scheduled start/stop is out of scope for this skeleton. `task run` records now.
 */
import { Command } from "commander";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { TaskStore, resolveTaskWebhook, type Task, type EngineKind } from "./store.js";
import { resolveTaskStreamCookies } from "./stream-cookies.js";
import { rootHubConfig, resolveOutputDir } from "./paths.js";
import { resolveDbPath } from "./db.js";
import { parseSchedule, toDanmuFlag, parseBoolFlag } from "./task-input.js";

/**
 * 解析 hub 配置 JSON 串(供 startHub)。优先级:
 *   --hub-config(存在的文件路径→读文件;否则当内联 JSON 串) > settings 表 hubConfig > <root>/config/hub-config.json(自动读)。
 * 即:把 hub-config.example.json 复制成 hub-config.json 改完,`serve --hub` 即自动加载(无需 --hub-config)。都没有 → undefined(跳过)。
 */
export function resolveHubConfigJson(arg: string | undefined, store: TaskStore): string | undefined {
  if (arg) return existsSync(arg) ? readFileSync(arg, "utf-8") : arg;
  const fromDb = store.getSetting("hubConfig");
  if (fromDb) return fromDb;
  const p = rootHubConfig();
  if (existsSync(p)) return readFileSync(p, "utf-8");
  return undefined;
}
import { RecordingSession } from "@drec/manager";
import { createLogger, getEngine, getPlatform, platformForRoom } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import {
  makeNotifier,
  resolveWebhookToggles,
  shouldSendWebhook,
  webhookTogglesFromEnv,
  type NotifWebhookToggles,
} from "@drec/observability";
import type { Recorder, RecordOpts, NotifyEvent, Notifier } from "@drec/core";
import { TaskDaemon } from "./daemon.js";
import { TaskManager } from "./task-manager.js";
import { NodeRecordSpawner } from "./process/spawner.js";

// 本文件含多个命令组,日志按命令归属 scope:task→task_manager、daemon→scheduler、serve→web_server。
const log = createLogger("task_manager");
const daemonLog = createLogger("scheduler");
const serveLog = createLogger("web_server");

/** 房间号/URL → 规范直播 URL,按平台(URL 命中 / 裸房间号回落默认平台)。 */
export function roomToUrl(room: string): string {
  return platformForRoom(room).roomToUrl(room);
}

/**
 * Build a core RecordingSession + RecordOpts + url for a task. SHARED by
 * `task run` and the scheduling daemon so both wire recorder/danmu/notifier/opts
 * identically. Pure construction — does NOT call session.start() or set status.
 *
 * webhook precedence: explicit `webhook` arg (program --discord-webhook/env) >
 * settings table `discordWebhook`.
 */
export function buildSessionForTask(
  task: Task,
  store: TaskStore,
  webhook?: string,
): { session: RecordingSession; opts: RecordOpts; url: string } {
  // 通用录制器 + 选中的下载引擎(与 cli record 路径一致,无字符串分支)。非法/旧值回落平台默认引擎。
  // 弹幕来源由平台 connectDanmu 在 onLive 时提供(manager 内部),此处只决定弹幕开关(task.danmu)。
  const defaultEngine = getPlatform(task.platform)?.defaultEngine ?? "ffmpeg";
  const engine = getEngine(task.engine) ?? getEngine(defaultEngine)!;
  const recorder: Recorder = new PollingRecorder(engine);
  const danmuEnabled = !!task.danmu;

  const hook = webhook ?? store.getSetting("discordWebhook") ?? undefined;
  // webhook 按类型开关过滤(serve 注入 DREC_WEBHOOK_TOGGLES;手工 task run 无 env = 全关)。
  const toggles = webhookTogglesFromEnv();
  const notifier: Notifier = {
    notify: async (e: NotifyEvent): Promise<void> => {
      if (shouldSendWebhook(toggles, e)) await makeNotifier(hook).notify(e);
    },
  };

  // Cookie resolution gated by the per-task useCookie toggle (resolveTaskCookies
  // is the single source of truth, also used by TaskManager.spawnFor).
  const opts: RecordOpts = {
    quality: task.quality as RecordOpts["quality"],
    cookies: resolveTaskStreamCookies(task, store) ?? undefined,
    outDir: resolveOutputDir(task.outDir),
    segmentSec: task.segmentSec,
    // per-streamer output subfolder; empty/undefined → recorder auto-uses anchor name
    name: task.name ?? undefined,
  };

  const session = new RecordingSession(recorder, { notifier, danmuEnabled });
  return { session, opts, url: roomToUrl(task.room) };
}

/**
 * Build the `cookie` command group — manage platform account cookies.
 * The QR-login path lives
 * in the Web 控制台 (`task serve`); the terminal only does show/set/clear.
 *
 * Subcommands: show / set (--file | --str) / clear. All take --platform and --db.
 */
export function buildCookieCommand(): Command {
  const cookie = new Command("cookie").description(
    "管理平台账号 cookie（扫码登录请用 Web 控制台 task serve）",
  );

  /** A cookie string has a usable login session for the selected platform. */
  const hasSession = (c: string, platform: string): boolean =>
    platform === "bilibili"
      ? /(?:^|;\s*)SESSDATA=/.test(c)
      : platform === "kuaishou"
        ? /(?:^|;\s*)kuaishou\.web\.cp\.api_st=|(?:^|;\s*)passToken=|(?:^|;\s*)userId=/.test(c)
        : /(?:^|;\s*)sessionid(?:_ss)?=/.test(c);

  cookie
    .command("show")
    .description("查看平台 cookie 状态（不打印原始值）")
    .option("--platform <id>", "平台 id（默认 douyin）")
    .option("--db <path>", "数据库路径（默认 ./douyin-rec.db 或 env DOUYIN_REC_DB）")
    .action((o: { db?: string; platform?: string }) => {
      const platform = o.platform ?? "douyin";
      const store = new TaskStore(o.db);
      const value = store.getPlatformCookies(platform);
      store.close();
      if (!value) {
        console.log(`[cookie] ${platform} cookie: 未设置`);
        return;
      }
      console.log(
        `[cookie] ${platform} cookie: 已设置 · session=${hasSession(value, platform) ? "有" : "无"} · 长度=${value.length}`,
      );
    });

  cookie
    .command("set")
    .description("设置平台 cookie（从文件或字符串）")
    .option("--platform <id>", "平台 id（默认 douyin）")
    .option("--file <path>", "从文件读取 cookie（读取后 trim）")
    .option("--str <s>", "直接给 cookie 字符串")
    .option("--db <path>", "数据库路径")
    .action((o: { platform?: string; file?: string; str?: string; db?: string }) => {
      const platform = o.platform ?? "douyin";
      let value: string;
      if (o.file) value = readFileSync(o.file, "utf-8").trim();
      else if (o.str !== undefined) value = o.str.trim();
      else {
        console.error("[cookie] 需提供 --file <path> 或 --str <s>");
        process.exit(2);
        return;
      }
      if (!value) {
        console.error("[cookie] cookie 不能为空");
        process.exit(2);
        return;
      }
      const store = new TaskStore(o.db);
      store.setPlatformCookies(platform, value);
      store.close();
      console.log(
        `[cookie] 已设置 ${platform} cookie · session=${hasSession(value, platform) ? "有" : "无"} · 长度=${value.length}`,
      );
    });

  cookie
    .command("clear")
    .description("清除平台 cookie")
    .option("--platform <id>", "平台 id（默认 douyin）")
    .option("--db <path>", "数据库路径")
    .action((o: { db?: string; platform?: string }) => {
      const platform = o.platform ?? "douyin";
      const store = new TaskStore(o.db);
      store.setPlatformCookies(platform, "");
      store.close();
      console.log(`[cookie] 已清除 ${platform} cookie`);
    });

  return cookie;
}

interface AddOpts {
  room: string;
  name?: string;
  quality?: string;
  engine?: string;
  recorder?: string;
  danmu?: string;
  segment?: string;
  cookiesFile?: string;
  useCookie?: string;
  out?: string;
  schedule?: string;
  db?: string;
}

/**
 * Optional hub deps injected by cli (L5) into app (L4) to avoid circular deps.
 * cli depends on @drec/orchestrator; app does not.
 */
export interface HubStarter {
  start(opts: {
    hubConfigJson: string | undefined;
    dbPath: string | undefined;
    store: TaskStore;
    manager: {
      isRecording(id: number): boolean;
      isRunning(id: number): boolean;
      stop(id: number): Promise<void>;
    };
    onEvent: (e: import("@drec/core").NotifyEvent) => void;
    log: (msg: string) => void;
    warn: (msg: string) => void;
  }): Promise<(() => void) | undefined>;
  /** 连接测试(cli L5 用 orchestrator getTransport + listInventory 实现)。 */
  testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<import("@drec/core").WorkerTestResult>;
  /** 批量存活探针(cli L5 用 orchestrator scoped transport ping 实现)。省略 → status 端点返回 []。 */
  probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  /** master 控制台读取 hub 源任务的 worker 录制状态快照。 */
  recordingWorkers?: (platform: string, roomSlug: string) => import("@drec/core").RecordingWorkerStatusDTO[];
  /** master 资源池快照(读同一 ResourcePool 实例);队列页显示 CPU/上传占用与排队位次。省略 → 全 0。 */
  poolSnapshot?: () => import("@drec/core").HubPoolSnapshotDTO | undefined;
  /** 立即触发一次 hub 任务同步(规则/worker 变更后由 web API 调用;hub 未就绪时排队,start 后补跑)。 */
  requestSyncTasks?: () => void;
  /**
   * master 本机抑制名单:「源任务已由 hub 规则切到远端节点录制」→ 本机不应实跑。
   * 供 web API 的 startTask 判断(手动启动不得绕过 daemon 的抑制,否则双节点重复录制)。
   */
  localSuppressedIds?: () => ReadonlySet<number>;
  /** 手动重跑单个 workflow 节点(hub 未启用 → web API 返回 400)。 */
  retryNode?: (streamKey: string, node: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 停一场后处理(rsync/ffmpeg/biliup),不动录制。hub 未启用 → web API 返回 400。 */
  stopJob?: (streamKey: string) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 立刻跑一场已有录像的后处理(跳过 settle / 断流窗)。hub 未启用 → web API 返回 400。 */
  runNow?: (opts: { streamKey: string; winnerWorker?: string; wait?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string }>;
}

/** Build the `task` command group. Pass a getWebhook() that reads program-level opts/env. */
export function buildTaskCommand(getWebhook: () => string | undefined, hubStarter?: HubStarter): Command {
  const task = new Command("task").description("管理录制任务（持久化到 sqlite）");

  task
    .command("add")
    .description("新增录制任务")
    .requiredOption("--room <id|url>", "直播间房间号或完整 URL")
    .option("--name <s>", "主播名称")
    .option("--quality <q>", "画质: origin|uhd|hd|sd|ld (默认 origin)")
    .option("--engine <e>", "下载引擎(按平台: ffmpeg|mesio,省略=平台默认;非法值会列出该平台合法项)")
    .option("--recorder <r>", "[已废弃别名] 等价 --engine")
    .option("--danmu <0|1>", "弹幕开关: 1=开 0=关 (默认 1)")
    .option("--segment <sec>", "分段时长(秒), 0=不分段 (默认 1800)")
    .option("--cookies-file <path>", "从文件读取本任务专属 cookie（可选覆盖；默认用本平台 cookie）")
    .option("--use-cookie <0|1>", "弹幕含礼物: 1=含礼物(需账号cookie) 0=仅评论(匿名) (默认 1)")
    .option("--out <dir>", "输出目录")
    .option("--schedule <HH:MM-HH:MM>", "定时窗口（仅存储，本骨架不自动启停）")
    .option("--db <path>", "数据库路径（默认 ./douyin-rec.db 或 env DOUYIN_REC_DB）")
    .action(async (o: AddOpts) => {
      const store = new TaskStore(o.db);
      let scheduleStart: string | null = null;
      let scheduleEnd: string | null = null;
      if (o.schedule) [scheduleStart, scheduleEnd] = parseSchedule(o.schedule);
      const cookies = o.cookiesFile ? readFileSync(o.cookiesFile, "utf-8").trim() : null;
      // 平台驱动:按 room 判别平台,engine 校验/默认从平台取(去抖音硬编码)。--recorder 为兼容别名。
      const platform = platformForRoom(o.room);
      const engine = (o.engine ?? o.recorder ?? platform.defaultEngine) as EngineKind;
      if (!platform.engines.includes(engine)) {
        log.error(`--engine 仅支持 ${platform.engines.join(" | ")}(平台 ${platform.id})`);
        process.exit(2);
      }
      // 短链/用户名入库即转换 → 数字 web_rid。
      let room = o.room;
      const initialSlug = platform.extractRoomSlug(room);
      if (platform.resolveShortUrl && !/^\d+$/.test(initialSlug)) {
        const { resolveShortUrl } = await import("./anchor.js");
        const roomId = await resolveShortUrl(room);
        if (roomId) {
          room = platform.roomToUrl(roomId);
          log.info(`房间地址已转换 → ${room}`);
        } else {
          log.warn(`web_rid 解析失败,按原样存(运行时仍会内部解析): ${room}`);
        }
      }
      const t = store.addTask({
        room,
        platform: platform.id,
        name: o.name ?? null,
        quality: o.quality ?? platform.defaultQuality,
        engine,
        danmu: toDanmuFlag(o.danmu),
        segmentSec: o.segment !== undefined ? Number(o.segment) : 1800,
        cookies,
        useCookie: parseBoolFlag(o.useCookie, true),
        outDir: o.out ?? null,
        scheduleStart,
        scheduleEnd,
      });
      store.close();
      log.info(`已创建任务 id=${t.id}（${t.name ?? t.room}）`);
    });

  task
    .command("edit")
    .description("编辑录制任务（仅更新本次提供的字段；运行中任务下次启动生效）")
    .argument("<id>", "任务 id")
    .option("--room <id|url>", "直播间房间号或完整 URL")
    .option("--name <s>", "主播名称")
    .option("--quality <q>", "画质: origin|uhd|hd|sd|ld")
    .option("--engine <e>", "下载引擎(按平台: ffmpeg|mesio;非法值会列出该平台合法项)")
    .option("--recorder <r>", "[已废弃别名] 等价 --engine")
    .option("--danmu <0|1>", "弹幕开关: 1=开 0=关")
    .option("--segment <sec>", "分段时长(秒), 0=不分段")
    .option("--cookies-file <path>", "从文件读取本任务专属 cookie")
    .option("--use-cookie <0|1>", "弹幕含礼物: 1=含礼物(需账号cookie) 0=仅评论(匿名)")
    .option("--out <dir>", "输出目录")
    .option("--schedule <HH:MM-HH:MM>", "定时窗口（仅存储，本骨架不自动启停）")
    .option("--db <path>", "数据库路径（默认 ./douyin-rec.db 或 env DOUYIN_REC_DB）")
    .action((id: string, o: AddOpts & { id?: string }) => {
      const store = new TaskStore(o.db);
      const existing = store.getTask(Number(id));
      if (!existing) {
        log.error(`未找到任务 id=${id}`);
        store.close();
        process.exit(1);
        return;
      }

      // Only fields the user actually passed get updated — commander leaves
      // unset options `undefined`, so we key off that (no overwrite-with-default).
      const patch: Parameters<TaskStore["updateTask"]>[1] = {};
      if (o.room !== undefined) patch.room = o.room;
      if (o.name !== undefined) patch.name = o.name;
      if (o.quality !== undefined) patch.quality = o.quality;
      // --engine(或兼容别名 --recorder)→ 校验到平台合法引擎。
      const engineOpt = o.engine ?? o.recorder;
      if (engineOpt !== undefined) {
        const platform = getPlatform(existing.platform) ?? platformForRoom(existing.room);
        if (!platform.engines.includes(engineOpt)) {
          log.error(`--engine 仅支持 ${platform.engines.join(" | ")}(平台 ${platform.id})`);
          store.close();
          process.exit(2);
          return;
        }
        patch.engine = engineOpt as EngineKind;
      }
      if (o.danmu !== undefined) patch.danmu = toDanmuFlag(o.danmu);
      if (o.segment !== undefined) patch.segmentSec = Number(o.segment);
      if (o.cookiesFile !== undefined) {
        patch.cookies = readFileSync(o.cookiesFile, "utf-8").trim();
      }
      if (o.useCookie !== undefined) patch.useCookie = parseBoolFlag(o.useCookie, true);
      if (o.out !== undefined) patch.outDir = o.out;
      if (o.schedule !== undefined) {
        const [s, e] = parseSchedule(o.schedule);
        patch.scheduleStart = s;
        patch.scheduleEnd = e;
      }

      const updated = store.updateTask(Number(id), patch);
      store.close();
      if (!updated) {
        log.error(`未找到任务 id=${id}`);
        process.exit(1);
        return;
      }
      log.info(`已更新任务 id=${updated.id}（${updated.name ?? updated.room}）`);
    });

  task
    .command("list")
    .description("列出所有任务")
    .option("--db <path>", "数据库路径")
    .action((o: { db?: string }) => {
      const store = new TaskStore(o.db);
      const tasks = store.listTasks();
      store.close();
      if (tasks.length === 0) {
        console.log("(无任务)");
        return;
      }
      const header = ["id", "room", "name", "quality", "danmu", "cookie", "schedule", "status"];
      const rows = tasks.map((t) => [
        String(t.id),
        t.room,
        t.name ?? "",
        t.quality,
        t.danmu ? "on" : "off",
        t.useCookie ? "用" : "否",
        t.scheduleStart && t.scheduleEnd ? `${t.scheduleStart}-${t.scheduleEnd}` : "",
        t.status,
      ]);
      printTable(header, rows);
    });

  task
    .command("remove")
    .description("删除任务")
    .argument("<id>", "任务 id")
    .option("--db <path>", "数据库路径")
    .action((id: string, o: { db?: string }) => {
      const store = new TaskStore(o.db);
      const ok = store.removeTask(Number(id));
      store.close();
      if (!ok) {
        log.error(`未找到任务 id=${id}`);
        process.exit(1);
      }
      log.info(`已删除任务 id=${id}`);
    });

  task
    .command("run")
    .description("立即运行任务（录制至 Ctrl-C；不按 schedule 自动启停）")
    .argument("<id>", "任务 id")
    .option("--db <path>", "数据库路径")
    .action(async (id: string, o: { db?: string }) => {
      const store = new TaskStore(o.db);
      const t = store.getTask(Number(id));
      if (!t) {
        console.error(`[task] 未找到任务 id=${id}`);
        store.close();
        process.exit(1);
        return;
      }
      await runTask(store, t, getWebhook());
    });

  task
    .command("daemon")
    .description("定时调度守护进程：按各任务 schedule 窗口（本地时区，支持跨夜）自动启停录制")
    .option("--db <path>", "数据库路径")
    .option("--interval <sec>", "调度检查间隔(秒) (默认 60)")
    .action((o: { db?: string; interval?: string }) => {
      const store = new TaskStore(o.db);
      const intervalMs = o.interval !== undefined ? Number(o.interval) * 1000 : 60_000;
      // Each task runs as an isolated `record` subprocess. The spawner is the
      // ONLY piece that knows how to turn a Task into a real OS process; the
      // manager owns lifecycle + crash auto-restart; the daemon only gates by
      // the schedule. webhook is threaded through as a GLOBAL flag.
      const spawner = new NodeRecordSpawner({
        // getter:每次 spawn 读「全局 --discord-webhook/env ?? settings 表 discordWebhook」,
        // 否则 UI 里设的 webhook 进不了子进程(子进程无 DB,只能靠 --discord-webhook 透传)。
        webhook: () => getWebhook() ?? store.getSetting("discordWebhook") ?? undefined,
        // mesio 路径设置:每次 spawn 读 settings.mesioPath(空=引擎兜底 bin/mesio)→ 注入 MESIO_PATH。
        mesioPath: () => store.getSetting("mesioPath") || undefined,
        // 抖音 API 模式设置:每次 spawn 读 settings.douyinApiMode(空=默认 balance)→ 注入 DOUYIN_REC_API_MODE。
        douyinApiMode: () => store.getSetting("douyinApiMode") || undefined,
        // webhook 类型开关:每次 spawn 读 settings → DREC_WEBHOOK_TOGGLES 注入子进程。
        webhookToggles: () => resolveWebhookToggles(store.getSetting("notifWebhookToggles")),
        onLog: (m) => console.log(m),
      });
      const manager = new TaskManager(store, spawner, {
        autoRestart: true,
        log: (m) => console.log(m),
      });
      const daemon = new TaskDaemon(store, manager, { intervalMs });

      const tasks = store.listTasks();
      daemonLog.info(`启动定时调度，检查间隔 ${intervalMs / 1000}s，共 ${tasks.length} 个任务：`);
      for (const t of tasks) {
        const win =
          t.scheduleStart && t.scheduleEnd
            ? `${t.scheduleStart}-${t.scheduleEnd}（本地时区）`
            : "无窗口 → 始终录制";
        console.log(`  id=${t.id} ${t.name ?? t.room}  schedule=${win}`);
      }

      let stopping = false;
      const shutdown = (sig: string): void => {
        if (stopping) return;
        stopping = true;
        daemonLog.info(`\n收到 ${sig}，停止所有任务…`);
        void daemon
          .stop()
          .then(() => {
            store.close();
            daemonLog.info("已停止");
            process.exit(0);
          })
          .catch((err: unknown) => {
            store.close();
            daemonLog.error("停止时出错:", err);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      daemon.start();
      daemonLog.info("调度运行中… Ctrl-C 停止");
    });

  task

  return task;
}

/** Wire an app Task → core RecordingSession and record until a stop signal. */
async function runTask(store: TaskStore, t: Task, webhookArg?: string): Promise<void> {
  const { session, opts, url } = buildSessionForTask(t, store, webhookArg);

  let stopping = false;
  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`\n收到 ${sig}，正在停止任务 ${t.id}…`);
    void session
      .stop()
      .then(() => {
        store.setStatus(t.id, "stopped");
        store.close();
        log.info("已停止");
        process.exit(0);
      })
      .catch((err: unknown) => {
        store.setStatus(t.id, "error");
        store.close();
        log.error("停止时出错:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  store.setStatus(t.id, "running");
  log.info(
    `运行任务 id=${t.id} engine=${t.engine} danmu=${t.danmu ? "on" : "off"} ` +
      `cookie=${t.useCookie ? (opts.cookies ? "用" : "用(未设全局)") : "否"} ` +
      `quality=${opts.quality} segment=${opts.segmentSec}s out=${opts.outDir}`,
  );
  if (t.scheduleStart && t.scheduleEnd) {
    log.info(`注意：schedule ${t.scheduleStart}-${t.scheduleEnd} 仅记录，task run 立即录制不自动启停（用 task daemon 走定时）`);
  }
  log.info(`开始录制: ${url}`);

  try {
    await session.start(url, opts, { anchorName: t.name ?? "" });
    log.info("录制中… Ctrl-C 停止");
  } catch (err) {
    store.setStatus(t.id, "error");
    store.close();
    throw err;
  }
}

/** Minimal fixed-width table printer (CJK-naive; good enough for CLI inspection). */
function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
}
