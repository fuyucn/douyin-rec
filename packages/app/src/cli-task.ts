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
import { readFileSync, mkdirSync } from "node:fs";
import { TaskStore, resolveTaskCookies, resolveTaskWebhook, type Task, type EngineKind } from "./store.js";
import { EventCenter } from "./events.js";
import { resolveOutputDir } from "./paths.js";
import { RecordingSession } from "@drec/manager";
import { createLogger, getEngine, getPlatform, platformForRoom } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import { makeNotifier } from "./notify/notifier.js";
import type { Recorder, RecordOpts } from "@drec/core";
import { TaskDaemon } from "./daemon.js";
import { TaskManager } from "./task-manager.js";
import { TaskLogStore } from "./task-logs.js";
import { NodeRecordSpawner } from "./process/spawner.js";
import { createWebServer } from "./web/server.js";
import { QrLoginManager } from "./login/login-manager.js";
import { PlaywrightQrLogin } from "./login/qr-login.js";

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
  const notifier = makeNotifier(hook);

  // Cookie resolution gated by the per-task useCookie toggle (resolveTaskCookies
  // is the single source of truth, also used by TaskManager.spawnFor).
  const opts: RecordOpts = {
    quality: task.quality as RecordOpts["quality"],
    cookies: resolveTaskCookies(task, store.getDefaultCookies()) ?? undefined,
    outDir: task.outDir ?? store.getSetting("outDir") ?? "./recordings",
    segmentSec: task.segmentSec,
    // per-streamer output subfolder; empty/undefined → recorder auto-uses anchor name
    name: task.name ?? undefined,
  };

  const session = new RecordingSession(recorder, { notifier, danmuEnabled });
  return { session, opts, url: roomToUrl(task.room) };
}

/**
 * Build the `cookie` command group — manage the GLOBAL Douyin account cookie
 * (settings key `defaultCookies`, shared by ALL tasks). The QR-login path lives
 * in the Web 控制台 (`task serve`); the terminal only does show/set/clear.
 *
 * Subcommands: show / set (--file | --str) / clear. All take an optional --db.
 */
export function buildCookieCommand(): Command {
  const cookie = new Command("cookie").description(
    "管理全局抖音账号 cookie（所有任务共享；扫码登录请用 Web 控制台 task serve）",
  );

  /** A cookie string has a usable login session if it carries sessionid[_ss]. */
  const hasSession = (c: string): boolean => /(?:^|;\s*)sessionid(?:_ss)?=/.test(c);

  cookie
    .command("show")
    .description("查看全局 cookie 状态（不打印原始值）")
    .option("--db <path>", "数据库路径（默认 ./douyin-rec.db 或 env DOUYIN_REC_DB）")
    .action((o: { db?: string }) => {
      const store = new TaskStore(o.db);
      const value = store.getDefaultCookies();
      store.close();
      if (!value) {
        console.log("[cookie] 全局 cookie: 未设置");
        return;
      }
      console.log(
        `[cookie] 全局 cookie: 已设置 · sessionid=${hasSession(value) ? "有" : "无"} · 长度=${value.length}`,
      );
    });

  cookie
    .command("set")
    .description("设置全局 cookie（从文件或字符串）")
    .option("--file <path>", "从文件读取 cookie（读取后 trim）")
    .option("--str <s>", "直接给 cookie 字符串")
    .option("--db <path>", "数据库路径")
    .action((o: { file?: string; str?: string; db?: string }) => {
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
      store.setSetting("defaultCookies", value);
      store.close();
      console.log(
        `[cookie] 已设置全局 cookie · sessionid=${hasSession(value) ? "有" : "无"} · 长度=${value.length}`,
      );
    });

  cookie
    .command("clear")
    .description("清除全局 cookie")
    .option("--db <path>", "数据库路径")
    .action((o: { db?: string }) => {
      const store = new TaskStore(o.db);
      store.setSetting("defaultCookies", "");
      store.close();
      console.log("[cookie] 已清除全局 cookie");
    });

  return cookie;
}

/** Parse "HH:MM-HH:MM" → [start, end]; throws on malformed input. */
function parseSchedule(s: string): [string, string] {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`--schedule 格式应为 HH:MM-HH:MM，收到: ${s}`);
  return [m[1], m[2]];
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

/** Parse a 0/1/on/off/true/false flag string → boolean. Defaults to `def`. */
function parseBoolFlag(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return !["0", "off", "false", "no", "none"].includes(v.trim().toLowerCase());
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
    manager: { isRecording(id: number): boolean };
    onEvent: (e: import("@drec/core").NotifyEvent) => void;
    log: (msg: string) => void;
    warn: (msg: string) => void;
  }): Promise<(() => void) | undefined>;
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
    .option("--cookies-file <path>", "从文件读取本任务专属 cookie（可选覆盖；默认用全局 cookie）")
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
      // 短链入库即转换:v.douyin.com/XXX → https://live.douyin.com/<web_rid>。
      let room = o.room;
      if (/v\.douyin\.com\//.test(room)) {
        const { resolveShortUrl } = await import("./anchor.js");
        const webRid = await resolveShortUrl(room);
        if (webRid) {
          room = `https://live.douyin.com/${webRid}`;
          log.info(`短链已转换 → ${room}`);
        } else {
          log.warn(`短链解析失败,按原样存(运行时仍会内部解析): ${room}`);
        }
      }
      const t = store.addTask({
        room,
        platform: platform.id,
        name: o.name ?? null,
        quality: o.quality ?? platform.defaultQuality,
        engine,
        danmu: o.danmu !== undefined ? (["0", "off", "false", "none"].includes(o.danmu) ? 0 : 1) : 1,
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
      if (o.danmu !== undefined) {
        patch.danmu = ["0", "off", "false", "none"].includes(o.danmu) ? 0 : 1;
      }
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
    .command("serve")
    .description("启动 Web 控制台：HTTP 服务 + SPA + 定时调度守护（默认开；--no-schedule 关）")
    .option("--port <n>", "监听端口（默认 7860）")
    .option("--db <path>", "数据库路径")
    // 调度默认开：启用的任务无窗口=24h 录、有窗口=窗口内录。--no-schedule 退化为纯手动控制台。
    .option("--no-schedule", "关闭定时调度，仅手动启停（默认开启调度）")
    .option("--hub", "启用多节点同步编排(默认关)")
    .option("--hub-config <json>", "hub 配置 JSON")
    .action((o: { port?: string; db?: string; schedule?: boolean; hub?: boolean; hubConfig?: string }) => {
      const store = new TaskStore(o.db);
      const port = o.port !== undefined ? Number(o.port) : 7860;

      // ONE manager drives both the web (manual start/stop) and, if requested,
      // the scheduler (automatic start/stop). They share the same subprocess
      // lifecycle + crash auto-restart.
      const spawner = new NodeRecordSpawner({
        // getter:每次 spawn 读「全局 --discord-webhook/env ?? settings 表 discordWebhook」(与下方
        // EventCenter 的 globalHook 一致),否则 UI 里设的 webhook 进不了子进程(子进程无 DB)。
        webhook: () => getWebhook() ?? store.getSetting("discordWebhook") ?? undefined,
        // mesio 路径设置:每次 spawn 读 settings.mesioPath(空=引擎兜底 bin/mesio)→ 注入 MESIO_PATH。
        mesioPath: () => store.getSetting("mesioPath") || undefined,
        onLog: (m) => console.log(m),
      });
      // Per-task log ring buffer shared with the manager so the Web 详情/日志
      // 页面 can tail each recorder subprocess's captured output.
      const logStore = new TaskLogStore();
      const manager = new TaskManager(store, spawner, {
        autoRestart: true,
        log: (m) => console.log(m),
        logStore,
        // 重启耗尽彻底停 → 告警(events 在下方初始化,回调在崩溃时才触发,届时已就绪)。
        onTaskDown: (taskId, reason) => {
          const t = store.getTask(taskId);
          events.emit(taskId, { kind: "error", stage: "录制中断", message: `任务「${t?.name ?? t?.anchorName ?? taskId}」${reason}` });
        },
        // 子进程结构化告警(取流失败/卡死/录制错误)→ 站内 toast(webhook 子进程已发,故 webhook:false 不重发)。
        onAlert: (taskId, stage, message) => {
          events.emit(taskId, { kind: "error", stage, message }, { webhook: false });
        },
      });

      // QR-login manager: Playwright stays isolated inside PlaywrightQrLogin
      // (lazy-imported). If playwright isn't installed, start() throws a clear
      // message which the api turns into a 500 — manual cookie keeps working.
      const login = new QrLoginManager(
        store,
        () => new PlaywrightQrLogin({ log: (m) => console.log(m) }),
        { log: (m) => console.log(m) },
      );

      // 站内事件中枢:每个事件 → 本地事件流(web/tui 轮询)+ 按「任务 webhook ?? 全局」发 Discord。
      const globalHook = (): string | null => getWebhook() ?? store.getSetting("discordWebhook") ?? null;
      const events = new EventCenter({
        // 墙钟播种游标:进程重启后 id 仍单调,前端旧游标不会过滤掉重启窗口内的新事件。
        initialSeq: Date.now(),
        makeNotifier,
        resolveWebhook: (taskId) => {
          const t = taskId == null ? null : store.getTask(taskId);
          return resolveTaskWebhook(t ?? { webhook: null }, globalHook()) ?? undefined;
        },
      });
      const server = createWebServer({ store, manager, login, events, log: (m) => console.log(m) });

      // 开播/收播观察器:轮询 manager.isRecording 翻转 → emit 到本地流(Discord 已由录制子进程
      // 用每任务 webhook 发,故 { webhook:false } 不重复推)。首次见到只播种不触发,避免启动即误报。
      const lastRec = new Map<number, boolean>();
      const recWatch = setInterval(() => {
        for (const t of store.listTasks()) {
          const rec = manager.isRecording(t.id);
          const prev = lastRec.get(t.id);
          lastRec.set(t.id, rec);
          if (prev === undefined || rec === prev) continue;
          const anchor = manager.getAnchorName(t.id) ?? t.anchorName ?? t.name ?? t.room;
          events.emit(
            t.id,
            rec
              ? { kind: "recordStart", anchor, room: t.room, quality: t.quality }
              : { kind: "recordEnd", anchor, room: t.room, outDir: t.outDir ?? "" },
            { webhook: false },
          );
        }
      }, 3000);

      // 磁盘看门狗:输出根剩余 < 阈值 → 全局告警(原画很快写满盘;Python 版有此保护,TS 重写漏了)。
      const DISK_MIN_GB = Number(process.env.DOUYIN_REC_DISK_MIN_GB ?? 5);
      let diskAlerted = false;
      const diskWatch = setInterval(() => {
        void (async () => {
          try {
            const { statfs } = await import("node:fs/promises");
            const dir = resolveOutputDir(null);
            mkdirSync(dir, { recursive: true }); // 确保存在,statfs 才能查到该卷
            const st = await statfs(dir);
            const freeGB = (Number(st.bavail) * Number(st.bsize)) / 1e9;
            if (freeGB < DISK_MIN_GB) {
              if (!diskAlerted) {
                diskAlerted = true;
                events.emit(null, { kind: "error", stage: "磁盘", message: `输出目录(${dir})剩余 ${freeGB.toFixed(1)}GB,低于阈值 ${DISK_MIN_GB}GB —— 可能很快写满导致录制损坏` });
              }
            } else {
              diskAlerted = false; // 回升 → 复位,下次再低可再报
            }
          } catch {
            /* statfs 失败忽略 */
          }
        })();
      }, 60_000);

      // cookie 临期看门狗:剩 ≤ N 天(或已过期)→ 告警(过期后静默降级匿名,丢礼物/入场)。
      const COOKIE_WARN_DAYS = Number(process.env.DOUYIN_REC_COOKIE_WARN_DAYS ?? 3);
      let cookieWarned = false;
      const checkCookieExpiry = async (): Promise<void> => {
        try {
          const { parseCookieExpiry } = await import("./web/api.js");
          const c = store.getDefaultCookies();
          if (!c) return;
          const exp = parseCookieExpiry(c);
          if (exp == null) return;
          const days = Math.floor((exp - Date.now()) / 86400000);
          if (days <= COOKIE_WARN_DAYS) {
            if (!cookieWarned) {
              cookieWarned = true;
              events.emit(null, {
                kind: "error",
                stage: "cookie",
                message: days < 0
                  ? `账号 cookie 已过期 ${-days} 天,弹幕已降级匿名(丢礼物/入场),请重新登录`
                  : `账号 cookie ${days} 天后过期,请尽快续期,否则丢礼物/入场`,
              });
            }
          } else {
            cookieWarned = false;
          }
        } catch {
          /* ignore */
        }
      };
      void checkCookieExpiry();
      const cookieWatch = setInterval(() => void checkCookieExpiry(), 6 * 3600_000);

      // a_bogus 心跳 canary(默认关;设 DOUYIN_REC_CANARY_ROOM 才启用)。默认 12h 探一次某已知房间:
      // getInfo 能返回=签名正常(房间在播/没播都行),连续两次抛=API/签名真坏 → 提前告警(没任务也能知道)。
      const CANARY_ROOM = (process.env.DOUYIN_REC_CANARY_ROOM ?? "").trim();
      const CANARY_HOURS = Number(process.env.DOUYIN_REC_CANARY_HOURS ?? 12);
      let canaryWatch: ReturnType<typeof setInterval> | undefined;
      if (CANARY_ROOM) {
        const canaryCheck = async (): Promise<void> => {
          try {
            const { getInfo, extractRoomSlug } = await import("@drec/douyin-live");
            const slug = extractRoomSlug(CANARY_ROOM);
            const probe = async (): Promise<boolean> => { try { await getInfo(slug, {}); return true; } catch { return false; } };
            if (await probe()) return;            // 一次成功即健康
            if (await probe()) return;            // 二次确认,排除单次网络抖动
            events.emit(null, { kind: "error", stage: "签名探测", message: `抖音 API 探测连续失败(canary room=${slug}),疑似 a_bogus 签名失效 —— 录制将无法取流,请尽快更新 @drec/douyin-live` });
          } catch {
            /* 模块加载等异常忽略 */
          }
        };
        void canaryCheck();
        canaryWatch = setInterval(() => void canaryCheck(), CANARY_HOURS * 3600_000);
      }

      let daemon: TaskDaemon | undefined;
      if (o.schedule) {
        daemon = new TaskDaemon(store, manager, { log: (m) => console.log(m) });
      }

      // ── Hub：多节点同步编排（--hub 开启；默认关，默认路径完全不变）─────────────────
      // Hub 逻辑由 cli (L5) 通过 hubStarter 回调注入，app (L4) 不直接依赖 @drec/orchestrator，
      // 避免 app→orchestrator→app 的循环依赖（orchestrator 依赖 app 的 UploadOpts 等类型）。
      let stopHub: (() => void) | undefined;
      if (o.hub && hubStarter) {
        void hubStarter.start({
          hubConfigJson: o.hubConfig ?? store.getSetting("hubConfig") ?? undefined,
          dbPath: o.db,
          store,
          manager,
          onEvent: (e) => { events.emit(null, e); },
          log: (m) => serveLog.info(m),
          warn: (m) => serveLog.warn(m),
        }).then((stop) => { stopHub = stop; }).catch((err) => {
          serveLog.error("[hub] 启动失败:", err);
        });
      } else if (o.hub && !hubStarter) {
        serveLog.warn("[hub] --hub 已设置但未提供 hubStarter 实现，跳过");
      }

      let stopping = false;
      const shutdown = (sig: string): void => {
        if (stopping) return;
        stopping = true;
        clearInterval(recWatch);
        clearInterval(diskWatch);
        clearInterval(cookieWatch);
        if (canaryWatch) clearInterval(canaryWatch);
        if (stopHub) stopHub();
        serveLog.info(`\n收到 ${sig}，正在关闭…`);
        // Stop scheduler ticks first (so it won't re-start a task), then stop
        // every running recorder, then close the http server.
        const stopDaemon = daemon ? daemon.stop() : manager.stopAll();
        void Promise.resolve(stopDaemon)
          .then(() => new Promise<void>((r) => server.close(() => r())))
          .then(() => {
            store.close();
            serveLog.info("已关闭");
            process.exit(0);
          })
          .catch((err: unknown) => {
            store.close();
            serveLog.error("关闭时出错:", err);
            process.exit(1);
          });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      server.listen(port, () => {
        serveLog.info(`Web 控制台已启动: http://localhost:${port}`);
        if (daemon) {
          daemon.start();
          serveLog.info("定时调度已启用（默认；启用的任务无窗口=24h录/有窗口=窗口内录）");
        } else {
          serveLog.info("定时调度已关闭（--no-schedule）：仅手动启停");
        }
      });
    });

  // ── tui：终端交互界面（连 task serve 的 REST API）─────────────────────────────
  task
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
