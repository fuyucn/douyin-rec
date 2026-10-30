/**
 * app/serve.ts — `task serve` 的**运行时装配**(T-22 第 4 步从 cli-task.ts 抽出)。
 *
 * 职责:建 store → 时区 → 数据根初始化 → TaskManager/Spawner → QR login → EventCenter
 *      → Web server(托管 SPA + REST)+ 可选定时调度守护 + 可选 hub 编排。
 *
 * **命令定义**(`task serve` 的选项/描述)在 cli(T-22 第 4 步:命令定义属入口层);
 * 本文件只负责「拿到已解析的选项后怎么把服务跑起来」。cli 通过 `runServe(opts, deps)` 调它。
 */
import { existsSync, mkdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createLogger, freeBytesOf, freeGBOf, platformForRoom } from "@drec/core";
import { TaskStore, resolveTaskWebhook } from "./store.js";
import { resolveDbPath } from "./db.js";
import { EventCenter } from "@drec/observability";
import { drecRoot, procQueueDbPath, ensureHubConfigExample, ensureNodeIdentity, rootConfigDir, rootHubConfig, rootHubDir, resolveOutputDir } from "./paths.js";
import { localSuppressedSourceTaskIds } from "./hub-store.js";
import { refreshLocalRollingEffective } from "./rolling-effective.js";
import { resolveNodeOutputFormat } from "./node-remux.js";
import * as workerStore from "./worker-store.js";
import { applyTimezone } from "./timezone.js";
import { makeNotifier, resolveWebhookToggles, type HubLabelLookup } from "@drec/observability";
import { enrichHubEventSafely, makeHubLabelLookup, taskDisplayName } from "./hub-label-lookup.js";
import { TaskDaemon, resolveDiskWatermark } from "./daemon.js";
import { makeManualStartAdmit, currentDiskMinGB } from "./disk-gate.js";
import { ProcQueueStore, ProcRunner, SimpleSlotLimiter } from "@drec/proc-queue";
import { TaskManager } from "./task-manager.js";
import { masterSendsTransition, roomIsLive, workerProbeUsable, type LiveTick } from "./live-notify.js";
import { NotifyOutbox } from "./notify-outbox.js";
import { TaskLogStore } from "@drec/observability";
import { NodeRecordSpawner } from "./process/spawner.js";
import { sweepCredentialFiles } from "./process/credential-file.js";
import { createWebServer } from "./web/server.js";
import { HubWatch } from "./hub-watch.js";
import { QrLoginManager } from "./login/login-manager.js";
import { PlaywrightQrLogin } from "./login/qr-login.js";
import { BiliQrLogin } from "./login/bili-qr-login.js";
import { KuaishouQrLogin } from "./login/kuaishou-qr-login.js";
import { resolveHubConfig, resolveHubConfigJson, type HubStarter } from "./cli-task.js";

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

    // Credential files left by a force-killed previous serve: no live child needs them (each
    // child reads its file once at startup), and nothing has been spawned yet in this process.
    const swept = sweepCredentialFiles();
    if (swept.removed > 0) console.log(`[cred] 启动清扫:删除残留录制凭证文件 ${swept.removed} 个`);
    for (const f of swept.failed) console.error(`[cred] 启动清扫失败: ${f}`);

    // 受管节点(DREC_NOTIFY_RELAY=1)不自己做任何通知:事件写发件箱,由主控统一发送(issue #405)。
    // 子进程与本站中枢都必须静默,否则节点本地与主控会各发一条。
    // 只认显式开关:目录标记是历史残留,不能用来推断「现在仍受管」,否则会把通知静默憋死在节点上。
    const relayMode = process.env.DREC_NOTIFY_RELAY === "1";
    if (relayMode) serveLog.info("[notify] 中继模式:事件写入发件箱,由主控统一发送");

    // ONE manager drives both the web (manual start/stop) and, if requested,
    // the scheduler (automatic start/stop). They share the same subprocess
    // lifecycle + crash auto-restart.
    const spawner = new NodeRecordSpawner({
      // getter:每次 spawn 读「全局 --discord-webhook/env ?? settings 表 discordWebhook」(与下方
      // EventCenter 的 globalHook 一致),否则 UI 里设的 webhook 进不了子进程(子进程无 DB)。
      // 中继模式下节点不持有推送地址:不传给子进程,凭据文件也不会生成。
      webhook: () => relayMode ? undefined : getWebhook() ?? store.getSetting("discordWebhook") ?? undefined,
      // mesio 路径设置:每次 spawn 读 settings.mesioPath(空=引擎兜底 bin/mesio)→ 注入 MESIO_PATH。
      mesioPath: () => store.getSetting("mesioPath") || undefined,
      // 抖音 API 模式设置:每次 spawn 读 settings.douyinApiMode(空=默认 balance)→ 注入 DOUYIN_REC_API_MODE。
      douyinApiMode: () => store.getSetting("douyinApiMode") || undefined,
      // webhook 类型开关:每次 spawn 读 settings → DREC_WEBHOOK_TOGGLES 注入子进程。
      // 中继模式下子进程一律不发:类型开关强制全关(事件仍会经发件箱上报)。
      webhookToggles: () => relayMode
        ? { live: false, recordEnd: false, merge: false, hub: false, error: false }
        : resolveWebhookToggles(store.getSetting("notifWebhookToggles")),
      onLog: (m) => console.log(m),
    });
    // Per-task log ring buffer shared with the manager so the Web 详情/日志
    // 页面 can tail each recorder subprocess's captured output.
    const logStore = new TaskLogStore();
    // T17:HubWatch 必须**在 manager 之前**构造 —— TaskManager 的录制状态回调要打到这里,
    // 而 SSE 路由也要注入同一个实例(两处必须是同一个,否则「推了但没人听」)。
    // hubWatch 自身要在后面 hubEnabled 确定后再 start(见下),构造与 start 分开是为了这个顺序。
    let hubWatch: HubWatch | null = null;

    // hub 是否启用在 manager 之后才确定(见下),起录兜底用可变标志读取。
    let rollingGuardOn = false;
    const manager = new TaskManager(store, spawner, {
      autoRestart: true,
      // 边录边传 S3 兜底:master 起录前对该本机任务按当前规则现算一次生效值,再构造 record 参数。
      beforeSpawn: (taskId) => {
        if (rollingGuardOn) refreshLocalRollingEffective(store, rootHubDir(), [taskId], (m) => console.log(m));
      },
      // 节点侧原地替换容器(issue #137)的唯一判定点:每次 spawn 现读规则文件,
      // 无后处理的任务才把所选格式交给子进程;受管 / 有规则 / 边录边传一律 original。
      nodeOutputFormat: (task) => resolveNodeOutputFormat(task, rootHubDir()),
      log: (m) => console.log(m),
      logStore,
      // 录制状态(起停/开播/收播/崩溃)→ 立刻推一次 changed。
      // 台账指纹看不见这些变化(见 TaskManager.onRecordingStateChanged 注释),
      // 少了这一跳,房间页在开播/收播那几秒会是陈旧的。
      onRecordingStateChanged: () => hubWatch?.notifyChanged(),
      // 重启耗尽彻底停 → 告警(events 在下方初始化,回调在崩溃时才触发,届时已就绪)。
      onTaskDown: (taskId, reason) => {
        const t = store.getTask(taskId);
        const name = t ? taskDisplayName(t, manager.getAnchorName(taskId)) : String(taskId);
        events.emit(taskId, { kind: "error", stage: "录制中断", message: `任务「${name}」${reason}` });
      },
      // 子进程结构化告警(取流失败/卡死/录制错误)→ 站内 toast(webhook 子进程已发,故 webhook:false 不重发)。
      onAlert: (taskId, stage, message, ctx) => {
        // 中继节点:子进程已被静默,告警必须由主控代发,所以这里要标记成需要推送。
        events.emit(taskId, { kind: "error", stage, message, ...(ctx ? { ctx } : {}) }, { webhook: relayMode });
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
    let notifyOutbox: NotifyOutbox | null = null;
    if (relayMode) {
      try {
        notifyOutbox = new NotifyOutbox(join(drecRoot(), "db", "notify-outbox.db"));
      } catch (e) {
        serveLog.error("[notify] 发件箱打不开,本次仍按本地发送:", e);
      }
    }
    const events = new EventCenter({
      // 墙钟播种游标:进程重启后 id 仍单调,前端旧游标不会过滤掉重启窗口内的新事件。
      initialSeq: Date.now(),
      // 发件箱已就绪时由主控代发,本地不再持有发送方。
      ...(notifyOutbox ? {} : { makeNotifier }),
      ...(notifyOutbox
        ? { onEmit: (e: import("@drec/observability").AppEvent, meta: { webhook: boolean }) => {
          const t = e.taskId == null ? null : store.getTask(e.taskId);
          notifyOutbox!.append(e.taskId, t?.room ?? null, e.event, meta.webhook, e.at);
        } }
        : {}),
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
    // 边录边传生效值(issue #40):首轮 hub 同步前,先用唯一判定刷新绑定了规则的本机任务,
    // 堵住「同步未跑完、daemon 已起录」窗口里按旧开关放行而绕过多节点重复投稿闸门。失败只告警(回落旧开关迁移)。
    rollingGuardOn = hubEnabled;
    if (hubEnabled) {
      try {
        const n = refreshLocalRollingEffective(store, rootHubDir(), undefined, (m) => console.log(m));
        console.log(`[rolling] 启动刷新边录边传生效值:${n} 个任务绑定 hub 规则`);
      } catch (e) {
        console.warn(`[rolling] 启动刷新边录边传生效值失败(回落旧开关迁移):${String((e as Error)?.message ?? e)}`);
      }
    }
    // hub 台账路径与 cli hubStarter 同一推导(<db>-sync.db)——「hub 任务」端点读它展示进度/ETA/日志。
    const syncDbPath = resolveDbPath(o.db).replace(/\.db$/, "-sync.db");
    // T4:台账变更监视 → SSE(/api/hub/stream)。
    // **只在 master 起**:sync 台账的唯一写端是本节点的 orchestrator,slave 上那份文件永远不变
    // → 白白空转 1s 定时器、永远不推。不注入则该路由显式 503(而非静默 404/空流)。
    hubWatch = hubEnabled ? new HubWatch(syncDbPath, { log: (m) => serveLog.info(m) }) : null;
    hubWatch?.start();
    // 录制子进程继承本进程环境:把**当前生效的那份** hub 配置交给子进程,使其磁盘水位闸门
    // 与 serve(手动启动 / daemon)读同一份配置(issue #96)。
    //
    // 为什么不能只处理 arg-file:配置来源有四种(arg 文件 / inline JSON / settings 表 / 根文件),
    // 只传 arg-file 时,settings/inline 这两种来源下子进程会**回落去读根文件** —— 那份可能根本
    // 不是用户在用的一份(例如 UI 把 diskMinGB 设成 0 关闭闸门,却存在 settings 表里),
    // 结果子进程按根文件/默认 10GB 继续拦录,表现为「关了闸门还在拦」。
    // 统一做法:文件来源传路径(零拷贝、可热改);非文件来源(inline/settings)把 JSON 内容
    // 经环境变量传给子进程,口径与 daemon 完全一致。
    {
      const hubSrc = resolveHubConfig(o.hubConfig, store);
      if (hubSrc.source === "arg-file" && hubSrc.path) {
        process.env.DOUYIN_REC_HUB_CONFIG = hubSrc.path;
        delete process.env.DOUYIN_REC_HUB_CONFIG_JSON;
      } else if (hubSrc.json !== undefined) {
        process.env.DOUYIN_REC_HUB_CONFIG_JSON = hubSrc.json;
        delete process.env.DOUYIN_REC_HUB_CONFIG;
      } else {
        // 完全没配置:清掉两者,让子进程按默认水位(与 daemon 的 undefined 分支一致)。
        delete process.env.DOUYIN_REC_HUB_CONFIG;
        delete process.env.DOUYIN_REC_HUB_CONFIG_JSON;
      }
    }
    // 处理任务表 + 租约执行循环(plans/036 T3)。无注册处理器时空转;库打不开只告警、不拖垮 serve
    // (`/api/proc/*` 回 503)。serve 遇他人(record 子进程)持有租约 → 置 handover 请求,不抢正在跑的 job。
    let procStore: ProcQueueStore | null = null;
    let procRunner: ProcRunner | null = null;
    try {
      procStore = new ProcQueueStore(procQueueDbPath(), { log: (m) => serveLog.warn(m) });
      const numSetting = (key: string): number | undefined => {
        const n = Number(store.getSetting(key));
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      procRunner = new ProcRunner({
        store: procStore,
        owner: `serve:${process.pid}:${Date.now()}`,
        requestHandover: true,
        diskMinGB: () => currentDiskMinGB((m) => serveLog.warn(m)),
        alert: (taskId, message) => events.emit(taskId ?? null, { kind: "error", stage: "后处理", message }),
        log: (m) => serveLog.info(m),
        // 节点 settings `procLimits.<lane>`(默认 1,如 remux 的 copy 通道)与 `procShutdownWaitMs`(默认 15min)。
        limiter: new SimpleSlotLimiter((_resource, lane) => numSetting(`procLimits.${lane}`) ?? 1),
        shutdownWaitMs: numSetting("procShutdownWaitMs"),
      });
      procRunner.start();
    } catch (e) {
      serveLog.error("[proc] 处理任务表启动失败(后处理任务不可用,录制不受影响):", e);
      procStore?.close();
      procStore = null;
      procRunner = null;
    }
    const procRunnerRef = procRunner;
    const procStoreRef = procStore;
    const server = createWebServer({
      procActive: procRunnerRef ? () => procRunnerRef.active() : undefined,
      procPurge: procStoreRef ? (o) => ({ deleted: procStoreRef.gc({ purgeFailed: o.purgeFailed }) }) : undefined,
      store, manager, login, events, hubEnabled, syncDbPath, hubConfigPath: rootHubConfig(),
      // T15:告诉 API「master 实际在用哪份 hub 配置」—— UI 改 resources 必须写回那一份,
      // 而不是盲目写 rootHubConfig()(用户用 --hub-config / settings 时那是另一份文件)。
      // 用**函数**而非快照:配置来源不随运行变,但保持与 resolveHubConfig 同一口径、不缓存。
      hubConfigSource: () => resolveHubConfig(o.hubConfig, store),
      // hub 未启用不注入 → 端点回落 400(与 hub.start 一致的开关逻辑)。
      testWorker: hubEnabled ? hubStarter?.testWorker : undefined,
      probeAllWorkers: hubEnabled ? hubStarter?.probeAllWorkers : undefined,
      nodeTaskLogs: hubEnabled ? hubStarter?.nodeTaskLogs : undefined,
      nodeTasks: hubEnabled ? hubStarter?.nodeTasks : undefined,
      recordingWorkers: hubEnabled ? hubStarter?.recordingWorkers : undefined,
      zeroDiskStatus: hubEnabled ? hubStarter?.zeroDiskStatus : undefined,
      zeroDiskLive: hubEnabled ? hubStarter?.readZeroDiskLive : undefined,
      // issue #73:与 `_apply-tasks` 同目录(<数据根>/config/managed),节点列表据快照里的 assigned 标记过滤。
      managedStateDir: join(rootConfigDir(), "managed"),
      rollingDelivery: hubEnabled ? hubStarter?.rollingDelivery : undefined,
      blockedBroadcasts: hubEnabled ? hubStarter?.blockedBroadcasts : undefined,
      poolSnapshot: hubEnabled ? hubStarter?.poolSnapshot : undefined,
      requestSyncTasks: hubEnabled ? hubStarter?.requestSyncTasks : undefined,
      // 手动启动的磁盘水位准入(issue #96):与 daemon 同源的水位配置,每次现读(热改生效);测默认输出目录所在卷。
      // 与录制子进程同一份水位配置(effectiveHubConfigPath)与同一目录口径(任务自己的 outDir)。
      admitStart: makeManualStartAdmit((d) => resolveOutputDir(d ?? undefined)),
      // 与 daemon 同源:规则把源任务交给远端(workers 不含 local)时,本机不实跑。
      // 能力门控(T-10):远端还需满足规则的 requires 才算「有人接」(与 reconciler 同判定)。
      localSuppressedIds: hubEnabled
        ? () => {
            const workers = workerStore.listWorkers(rootHubConfig());
            const caps = new Map(workers.map((w) => [w.id, w.capabilities]));
            return localSuppressedSourceTaskIds(rootHubDir(), new Set(caps.keys()), (id) => caps.get(id));
          }
        : undefined,
      retryNode: hubEnabled ? hubStarter?.retryNode : undefined,
      stopJob: hubEnabled ? hubStarter?.stopJob : undefined,
      ackJob: hubEnabled ? hubStarter?.ackJob : undefined,
      runNow: hubEnabled ? hubStarter?.runNow : undefined,
      hubWatch: hubWatch ?? undefined,
      log: (m) => console.log(m),
    });

    // 开播/收播观察器:本机进程与 hub 节点任一在录即视为「这场在播」,翻转时 emit 一次。
    // 主控代发 webhook 的两种情形:本机直播直传(子进程不发),以及进程在 worker 上的房间
    // (子进程不在本机)。本机文件录制仍由录制子进程自己发,这里只进本地流,避免重复推送。
    // 记住上一 tick 的完整判定:{在播, 本机, 直播直传}。收播时用「刚结束的那场」的归属,
    // 因为本机文件录制在进程退出前就已把录制标记清掉,按当前 tick 判会给它重复推送。
    const lastRec = new Map<number, LiveTick>();
    const recWatch = setInterval(() => {
      for (const t of store.listTasks()) {
        const localRec = manager.isRecording(t.id);
        let workerStates: ReadonlyArray<{ state: string }> = [];
        if (!localRec && hubEnabled && hubStarter?.recordingWorkers) {
          try {
            const p = platformForRoom(t.room);
            workerStates = hubStarter.recordingWorkers(p.id, p.extractRoomSlug(t.room));
          } catch {
            workerStates = [{ state: "unavailable" }]; // 探测失败 → 保留上一轮判定,不能读成收播
          }
        }
        const prev = lastRec.get(t.id);
        // 节点探测不到时保留上一 tick 的判定:一次网络抖动不能被读成「收播」,否则会误报。
        const usableProbe = workerProbeUsable(workerStates);
        const rec = usableProbe ? roomIsLive(localRec, workerStates) : prev?.live ?? localRec;
        const next: LiveTick = { live: rec, local: localRec, streamUpload: t.streamUpload === true };
        if (prev === undefined) { lastRec.set(t.id, next); continue; }
        if (rec === prev.live) { lastRec.set(t.id, next); continue; }
        lastRec.set(t.id, next);
        const anchor = taskDisplayName(t, manager.getAnchorName(t.id));
        const selfNotifies = !masterSendsTransition(prev, next);
        events.emit(
          t.id,
          rec
            ? { kind: "recordStart", anchor, room: t.room, quality: t.quality }
            : { kind: "recordEnd", anchor, room: t.room, outDir: t.outDir ?? "" },
          // 中继节点只进本地流:开播/收播已由主控的代发逻辑统一发送(issue #403),
          // 再走中继就会重复。其余事件按原归属。
          { webhook: relayMode ? false : !selfNotifies },
        );
      }
    }, 3000);

    // 通知中继(issue #405):受管节点把事件写进自己的发件箱,主控每 10 秒按游标拉取,
    // 统一走本中枢发送,发送后确认。节点不持有推送凭据。旧 bundle 没有该命令 → 拉取返回空。
    const notifyCursors = new Map<string, number>();
    let notifyRunning = false;
    const notifyRelay = hubEnabled && hubStarter?.notifyOutbox
      ? setInterval(() => {
          if (notifyRunning) return; // 上一轮还没结束(慢节点/SSH 超时)时不并发重发
          notifyRunning = true;
          void (async () => {
            let workers: ReturnType<typeof workerStore.listWorkers> = [];
            try {
              workers = workerStore.listWorkers(rootHubConfig());
            } catch {
              return;
            }
            for (const w of workers) {
              if (w.kind === "local") continue; // 本机事件已经在主控自己的中枢里
              const after = notifyCursors.get(w.id) ?? 0;
              try {
                const rows = await hubStarter!.notifyOutbox!(w.id, after, 200, []);
                if (rows.length === 0) continue;
                let max = after;
                for (const r of rows) {
                  if (r.id > max) max = r.id;
                  // 节点与主控的 task id 是两套,必须按房间重新解析,否则可能发到别的房间。
                  const t = r.room
                    ? store.listTasks().find((x) => {
                        try {
                          const p = platformForRoom(x.room);
                          const q = platformForRoom(r.room!);
                          return p.id === q.id && p.extractRoomSlug(x.room) === q.extractRoomSlug(r.room!);
                        } catch {
                          return false;
                        }
                      })
                    : undefined;
                  events.emit(t?.id ?? null, r.event, { webhook: r.wantWebhook });
                }
                // 发送后再确认,确认成功才推进游标:确认失败时下一轮会重发,而不是丢事件。
                await hubStarter!.notifyOutbox!(w.id, max, 0, rows.map((r) => r.id));
                notifyCursors.set(w.id, max);
              } catch {
                // 节点不可达/旧版本 → 下一轮再试,不影响其它节点
              }
            }
          })().finally(() => { notifyRunning = false; });
        }, 10_000)
      : null;

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
          const freeGB = freeGBOf(st);
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
      const diskWatermark = resolveDiskWatermark(resolveHubConfigJson(o.hubConfig, store), (m) => console.warn(m));
      console.log(`[disk] 水位 = ${diskWatermark.bytes / 1e9} GB(来源:${diskWatermark.source})`);
      daemon = new TaskDaemon(store, manager, {
        log: (m) => console.log(m),
        // master(--hub)有效:规则把源任务交给远端节点(workers 不含 local)时,本机不再实跑该任务,
        // 避免本机持续轮询(触发风控)或双节点重复录制。daemon tick 现读规则文件,手改即时生效。
        // 能力门控(T-10):远端还要满足规则的 requires 才算「有人接」,否则本机不抑制(防两头不录)。
        localSuppressedIds: hubEnabled
          ? () => {
              const workers = workerStore.listWorkers(rootHubConfig());
              const caps = new Map(workers.map((w) => [w.id, w.capabilities]));
              return localSuppressedSourceTaskIds(rootHubDir(), new Set(caps.keys()), (id) => caps.get(id));
            }
          : undefined,
        // 磁盘低水位闸门(T-33 不变量 6):剩余低于水位 → 拒绝启动新任务(绝不用删未确认源腾空间,
        // 也不截断已在录的场)。阈值取 hub.config resources.diskMinGB(与 master 磁盘看门狗同源)。
        freeBytes: () => {
          // 数据根与录像目录同卷;录像目录可能尚未创建(全新部署)→ 依次回退数据根。
          // 都取不到(异常)→ null = 不拦(避免把探测失败当爆盘误停,已有磁盘看门狗告警兜底)。
          for (const p of [resolveOutputDir(undefined), drecRoot()]) {
            try { return freeBytesOf(statfsSync(p)); } catch { /* 试下一个 */ }
          }
          return null;
        },
        diskWatermarkBytes: diskWatermark.bytes,
      });
    }

    // ── Hub：多节点同步编排（--hub 开启；默认关，默认路径完全不变）─────────────────
    // Hub 逻辑由 cli (L5) 通过 hubStarter 回调注入，app (L4) 不直接依赖 @drec/orchestrator，
    // 避免 app→orchestrator→app 的循环依赖（orchestrator 依赖 app 的 UploadOpts 等类型）。
    let stopHub: (() => void) | undefined;
    // 每次发事件现取(任务/节点可在运行中增删);补全失败退回原事件,不影响 hub 流程。
    const hubLabelLookup = (): HubLabelLookup => makeHubLabelLookup({
      tasks: () => store.listTasks(),
      workers: () => workerStore.listWorkers(rootHubConfig()),
      liveAnchor: (id) => manager.getAnchorName(id),
    });
    if (o.hub && hubStarter) {
      void hubStarter.start({
        hubConfigJson: resolveHubConfigJson(o.hubConfig, store),
        // T15:传原始入参,让 hubStarter 能热读「当前生效的那份」配置(见 HubStarter 注释)。
        hubConfigArg: o.hubConfig,
        // 解析后的 db 路径(--db 省略+DOUYIN_REC_ROOT 时 → <root>/db/douyin-rec.db),
        // 使 hub 台账 <…>-sync.db 落数据根而非 cwd。
        dbPath: resolveDbPath(o.db),
        store,
        manager,
        // 发送前补主播名/日期/节点名:hub 事件原本只带房间号与 streamKey,webhook 里看不出是哪个直播间。
        onEvent: (e) => { events.emit(null, enrichHubEventSafely(e, hubLabelLookup, (m) => serveLog.warn(m))); },
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
      // 首步:停 runner(停认领 → 可中断 job 回 pending → 删租约),与 daemon 停止并行、都等完再关 http。
      const stopRunner = (procRunnerRef ? procRunnerRef.stop() : Promise.resolve()).catch((err: unknown) => {
        serveLog.error("[proc] runner 停止出错:", err);
      });
      clearInterval(recWatch);
      if (notifyRelay) clearInterval(notifyRelay);
      notifyOutbox?.close();
      clearInterval(diskWatch);
      clearInterval(cookieWatch);
      if (canaryWatch) clearInterval(canaryWatch);
      hubWatch?.stop();
      if (stopHub) stopHub();
      serveLog.info(`\n收到 ${sig}，正在关闭…`);
      // Stop scheduler ticks first (so it won't re-start a task), then stop
      // every running recorder, then close the http server.
      const stopDaemon = daemon ? daemon.stop() : manager.stopAll();
      void Promise.all([Promise.resolve(stopDaemon), stopRunner])
        .then(() => new Promise<void>((r) => server.close(() => r())))
        .then(() => {
          procStoreRef?.close();
          store.close();
          serveLog.info("已关闭");
          process.exit(0);
        })
        .catch((err: unknown) => {
          procStoreRef?.close();
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
