/**
 * app/serve.ts — `task serve` 的**运行时装配**(T-22 第 4 步从 cli-task.ts 抽出)。
 *
 * 职责:建 store → 时区 → 数据根初始化 → TaskManager/Spawner → QR login → EventCenter
 *      → Web server(托管 SPA + REST)+ 可选定时调度守护 + 可选 hub 编排。
 *
 * **命令定义**(`task serve` 的选项/描述)在 cli(T-22 第 4 步:命令定义属入口层);
 * 本文件只负责「拿到已解析的选项后怎么把服务跑起来」。cli 通过 `runServe(opts, deps)` 调它。
 */
import { mkdirSync } from "node:fs";
import { createLogger } from "@drec/core";
import { TaskStore, resolveTaskWebhook } from "./store.js";
import { resolveDbPath } from "./db.js";
import { EventCenter } from "@drec/observability";
import { ensureHubConfigExample, ensureNodeIdentity, rootHubConfig, rootHubDir, resolveOutputDir } from "./paths.js";
import { localSuppressedSourceTaskIds } from "./hub-store.js";
import * as workerStore from "./worker-store.js";
import { applyTimezone } from "./timezone.js";
import { makeNotifier, resolveWebhookToggles } from "@drec/observability";
import { TaskDaemon } from "./daemon.js";
import { TaskManager } from "./task-manager.js";
import { TaskLogStore } from "@drec/observability";
import { NodeRecordSpawner } from "./process/spawner.js";
import { createWebServer } from "./web/server.js";
import { QrLoginManager } from "./login/login-manager.js";
import { PlaywrightQrLogin } from "./login/qr-login.js";
import { BiliQrLogin } from "./login/bili-qr-login.js";
import { KuaishouQrLogin } from "./login/kuaishou-qr-login.js";
import { resolveHubConfigJson, type HubStarter } from "./cli-task.js";

/** `task serve` 已解析的选项。 */
// serve 命令的日志 scope(与拆分前 cli-task.ts 一致)。
const serveLog = createLogger("web_server");

/** `task serve` 已解析的选项。 */
export interface ServeOpts {
  port?: string;
  host?: string;
  db?: string;
  /** 定时调度(默认开;--no-schedule 关)。commander 的 --no-x 会把 x 置 false。 */
  schedule?: boolean;
  /** 启用多节点 hub 编排(默认关)。 */
  hub?: boolean;
  /** hub 配置(JSON 串或文件路径)。 */
  hubConfig?: string;
}

export interface ServeDeps {
  /** 全局 webhook 解析(program --discord-webhook / env)。 */
  getWebhook: () => string | undefined;
  /** 多节点 hub 编排实现(由 cli 注入,app 不依赖 orchestrator)。 */
  hubStarter?: HubStarter;
}

/** 跑起 Web 控制台(+ 可选调度 + 可选 hub)。行为与拆分前 `task serve` 完全一致。 */
export async function runServe(o: ServeOpts, deps: ServeDeps): Promise<void> {
  const { getWebhook, hubStarter } = deps;
    const store = new TaskStore(o.db);
    const port = o.port !== undefined ? Number(o.port) : 7860;
    const host = o.host?.trim() || undefined;

    // 时区由 config(settings.timezone)决定,不看 host/容器的 TZ 环境变量——覆盖式应用,
    // 启动就打日志,免得再靠挖 /proc/<pid>/environ 才能确认服务实际用的哪个时区(踩过的坑)。
    // schedule 窗口判定(inWindow/nowMinutesLocal)全靠 Date 的本地时间转换,这一行必须在
    // daemon 起来之前跑。Web UI/API 改设置后重新调 applyTimezone 即刻生效,不用重启。
    const tz = applyTimezone(store);
    console.log(`[tz] 时区 = ${tz}(来自 config,已覆盖 host 环境变量)`);

    // 数据根初始化时种一份多节点编排配置模板(<root>/config/hub-config.example.json,幂等)。
    const seeded = ensureHubConfigExample();
    if (seeded) console.log(`[hub] 已生成配置模板: ${seeded}(复制成同目录 hub-config.json 并改 host/cookies/uploadMode → serve --hub 自动加载)`);

    // 本节点稳定身份(<root>/config/node.json):首次启动生成,之后永久不变。
    // master 经 SSH `_node-id` 读到它作为 worker id(替代自分配 worker-N)—— 换 master/重启都不丢身份。
    const node = ensureNodeIdentity();
    console.log(`[node] 身份 = ${node.nodeId}${node.hostname ? ` (${node.hostname})` : ""}`);

    // ONE manager drives both the web (manual start/stop) and, if requested,
    // the scheduler (automatic start/stop). They share the same subprocess
    // lifecycle + crash auto-restart.
    const spawner = new NodeRecordSpawner({
      // getter:每次 spawn 读「全局 --discord-webhook/env ?? settings 表 discordWebhook」(与下方
      // EventCenter 的 globalHook 一致),否则 UI 里设的 webhook 进不了子进程(子进程无 DB)。
      webhook: () => getWebhook() ?? store.getSetting("discordWebhook") ?? undefined,
      // mesio 路径设置:每次 spawn 读 settings.mesioPath(空=引擎兜底 bin/mesio)→ 注入 MESIO_PATH。
      mesioPath: () => store.getSetting("mesioPath") || undefined,
      // 抖音 API 模式设置:每次 spawn 读 settings.douyinApiMode(空=默认 balance)→ 注入 DOUYIN_REC_API_MODE。
      douyinApiMode: () => store.getSetting("douyinApiMode") || undefined,
      // webhook 类型开关:每次 spawn 读 settings → DREC_WEBHOOK_TOGGLES 注入子进程。
      webhookToggles: () => resolveWebhookToggles(store.getSetting("notifWebhookToggles")),
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
      (platform) =>
        platform === "bilibili"
          ? new BiliQrLogin({ log: (m) => console.log(m) })
          : platform === "kuaishou"
            ? new KuaishouQrLogin({ log: (m) => console.log(m) })
            : new PlaywrightQrLogin({ log: (m) => console.log(m) }),
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
      // webhook 类型开关:EventCenter 发的 merge/upload/hub/error 等按设置过滤。
      webhookToggles: () => resolveWebhookToggles(store.getSetting("notifWebhookToggles")),
    });
    // hub 是否在本节点启用(master)?= --hub + 有 hubStarter + 能解析出 hub 配置。
    // slave(无 --hub)= false → 前端据此隐藏 Hub 页 / 显示 child node 提示。
    const hubEnabled = !!(o.hub && hubStarter && resolveHubConfigJson(o.hubConfig, store));
    // hub 台账路径与 cli hubStarter 同一推导(<db>-sync.db)——「hub 任务」端点读它展示进度/ETA/日志。
    const syncDbPath = resolveDbPath(o.db).replace(/\.db$/, "-sync.db");
    const server = createWebServer({
      store, manager, login, events, hubEnabled, syncDbPath, hubConfigPath: rootHubConfig(),
      // hub 未启用不注入 → 端点回落 400(与 hub.start 一致的开关逻辑)。
      testWorker: hubEnabled ? hubStarter?.testWorker : undefined,
      probeAllWorkers: hubEnabled ? hubStarter?.probeAllWorkers : undefined,
      recordingWorkers: hubEnabled ? hubStarter?.recordingWorkers : undefined,
      poolSnapshot: hubEnabled ? hubStarter?.poolSnapshot : undefined,
      requestSyncTasks: hubEnabled ? hubStarter?.requestSyncTasks : undefined,
      // 与 daemon 同源:规则把源任务交给远端(workers 不含 local)时,本机不实跑。
      localSuppressedIds: hubEnabled
        ? () => localSuppressedSourceTaskIds(
            rootHubDir(),
            new Set(workerStore.listWorkers(rootHubConfig()).map((w) => w.id)),
          )
        : undefined,
      retryNode: hubEnabled ? hubStarter?.retryNode : undefined,
      stopJob: hubEnabled ? hubStarter?.stopJob : undefined,
      runNow: hubEnabled ? hubStarter?.runNow : undefined,
      log: (m) => console.log(m),
    });

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
        const { parseCookieExpiry } = await import("./cookie-utils.js");
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
      daemon = new TaskDaemon(store, manager, {
        log: (m) => console.log(m),
        // master(--hub)有效:规则把源任务交给远端节点(workers 不含 local)时,本机不再实跑该任务,
        // 避免本机持续轮询(触发风控)或双节点重复录制。daemon tick 现读规则文件,手改即时生效。
        localSuppressedIds: hubEnabled
          ? () => localSuppressedSourceTaskIds(
              rootHubDir(),
              new Set(workerStore.listWorkers(rootHubConfig()).map((w) => w.id)),
            )
          : undefined,
      });
    }

    // ── Hub：多节点同步编排（--hub 开启；默认关，默认路径完全不变）─────────────────
    // Hub 逻辑由 cli (L5) 通过 hubStarter 回调注入，app (L4) 不直接依赖 @drec/orchestrator，
    // 避免 app→orchestrator→app 的循环依赖（orchestrator 依赖 app 的 UploadOpts 等类型）。
    let stopHub: (() => void) | undefined;
    if (o.hub && hubStarter) {
      void hubStarter.start({
        hubConfigJson: resolveHubConfigJson(o.hubConfig, store),
        // 解析后的 db 路径(--db 省略+DOUYIN_REC_ROOT 时 → <root>/db/douyin-rec.db),
        // 使 hub 台账 <…>-sync.db 落数据根而非 cwd。
        dbPath: resolveDbPath(o.db),
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

    const onListen = (): void => {
      const displayHost = host && host !== "0.0.0.0" && host !== "::" ? host : "localhost";
      serveLog.info(`Web 控制台已启动: http://${displayHost}:${port}`);
      if (daemon) {
        daemon.start();
        serveLog.info("定时调度已启用（默认；启用的任务无窗口=24h录/有窗口=窗口内录）");
      } else {
        serveLog.info("定时调度已关闭（--no-schedule）：仅手动启停");
      }
    };
    if (host) server.listen(port, host, onListen);
    else server.listen(port, onListen);
}
