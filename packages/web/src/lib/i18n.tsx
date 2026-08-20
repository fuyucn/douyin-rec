/**
 * i18n.tsx — react-i18next 配置(简体中文 / English)。
 *
 * 词典 DICT 直接作 i18next resources(嵌套 key,如 "nav.title")。**单花括号插值** {var}
 * (见底部 init 的 interpolation 配置);计数走 i18next 复数(count + _one/_other,如 tasks.lines)。
 * 语言持久化 localStorage(drec.lang),默认跟浏览器语言。
 *
 * 用法:const t = useT(); t("nav.title"); t("tasks.lines",{count:n});  const [lang,setLang]=useLang();
 */
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useCallback } from "react";

export type Lang = "zh" | "en";
const STORAGE = "drec.lang";

function detectInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved === "zh" || saved === "en") return saved;
    return /^zh/i.test(navigator.language) ? "zh" : "en"; // zh* → zh,其余 → en
  } catch {
    return "zh";
  }
}

/** 读/切当前语言(写 localStorage + i18next.changeLanguage)。 */
export function useLang(): [Lang, (l: Lang) => void] {
  const { i18n } = useTranslation();
  const lang = (i18n.language === "en" ? "en" : "zh") as Lang;
  const setLang = useCallback(
    (l: Lang) => {
      try {
        localStorage.setItem(STORAGE, l);
      } catch {
        /* ignore */
      }
      void i18n.changeLanguage(l);
    },
    [i18n],
  );
  return [lang, setLang];
}

/** t(key, vars):react-i18next 的 t(vars 作 options;含 count 触发复数)。 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const { t } = useTranslation();
  return useCallback((key: string, vars?: Record<string, string | number>) => t(key, vars ?? {}) as string, [t]);
}

// ── 词典(= i18next resources)──────────────────────────────────────────────────
// zh / en 同构。新增文案两边都加。值里用单花括号 {var} 占位;计数键用 _one/_other + {count}。
const DICT = {
  zh: {
    common: { cancel: "取消", confirm: "确定", save: "保存", delete: "删除", refresh: "刷新", close: "关闭", optional: "可选", on: "开", off: "关", yes: "是", no: "否", localTimeTooltip: "当前时区：{serverTz}\n你的本地时间：{local}" },
    nav: { title: "抖音录制控制台", tasksList: "录制任务", login: "扫码登录", paste: "手动粘贴", clear: "清除", notif: "站内提醒设置" },
    theme: { toDark: "切换到暗色", toLight: "切换到亮色", darkMode: "暗色模式", lightMode: "亮色模式" },
    cookie: {
      checking: "检查中…", loggedIn: "已登录", expired: "登录已过期", expiresIn: "剩 {days} 天过期",
      loggedInDays: "已登录 · 剩 {days} 天", noSession: "无 session", notSet: "未设置",
      clearConfirm: "清除全局 Cookie？所有任务将变为匿名连接。", cleared: "全局 Cookie 已清除", clearFailed: "清除失败: {msg}",
    },
    footer: { tagline: "抖音直播录制 · 弹幕捕获 · 后处理" },
    tasks: {
      empty: "暂无任务", add: "新建任务", room: "房间", openLive: "打开直播间", anchor: "主播", quality: "画质", recorder: "直播 provider",
      danmu: "弹幕", schedule: "定时窗口", giftCookie: "含礼物 cookie",
      outDir: "输出目录", startedAt: "开始时间", elapsed: "已录时长", logs: "日志", info: "任务信息",
      managed: "Hub 管理", managedHint: "由 hub 自动下发管理，请在 master 修改",
      start: "启动", stop: "停止", edit: "编辑", backToList: "任务列表", noLogs: "暂无日志（任务未运行或无输出）",
      lines_one: "{count} 行", lines_other: "{count} 行", started: "任务 {id} 已启动", stopped: "任务 {id} 已停止", deleted: "任务 {id} 已删除",
      startFailed: "启动失败: {msg}", stopFailed: "停止失败: {msg}", deleteFailed: "删除失败: {msg}",
      deleteConfirm: "删除任务 {id}？", unavailable: "任务不可用，返回列表", stopFirst: "请先停止任务再删除",
      pageTitle: "录制任务", pageSubtitle: "多任务直播流录制 · 弹幕 · 定时调度 · 列表每 2 秒自动刷新",
      metricTotal: "任务总数", metricRecording: "录制中", metricWaiting: "待命", metricError: "错误",
      connected: "已连接 · {time}", connFailed: "连接失败", loading: "加载中…", noneYet: "还没有任务",
      colName: "名称 / 房间", colQuality: "画质", colDanmu: "弹幕", colSchedule: "定时", colStatus: "状态", colAction: "操作",
      scheduleLocalTooltip: "当前时区：{serverTz}\n你的本地时间窗口：{local}",
      titleStart: "启动（启用）", titleStop: "停止（停用）", titleDetail: "详情", titleEdit: "编辑",
    },
    badge: { disabled: "已停用", draining: "排空中", recording: "录制中", waiting: "等待开播中", idle: "已启用·待命", error: "错误" },
    danmuKind: { off: "关闭", gift: "含礼物", anon: "匿名" },
    dialog: {
      createTitle: "新建录制任务", editTitle: "编辑任务", desc: "填写直播间与录制参数，全局 Cookie 在右上角统一管理。",
      platform: "平台: {id}",
      runningWarn: "运行中任务：修改将保存到数据库，下次启动生效。",
      room: "直播间（房间号或 URL）", roomPlaceholder: "36464127515 或 https://live.douyin.com/...",
      name: "主播名称", namePlaceholder: "可选，自动获取", quality: "画质",
      segment: "分段时长（秒，0 = 不分段）", scheduleWindow: "定时窗口（服务端时区）",
      schedulePlaceholder: "可选，如 22:30-01:00（支持跨夜）", schedHint: "按服务端配置的时区判断（现在 {now}{tz}），支持跨夜窗口如 22:30-01:00。",
      webhook: "通知 Webhook（Discord）", webhookPlaceholder: "可选，留空回落全局 webhook",
      webhookHint: "本任务专属：开播 / 录制完成 / 合并完成 / 出错时推送到此 Discord webhook。留空则用全局设置。",
      recDanmu: "录制弹幕", danmuGift: "弹幕含礼物 + 入场",
      giftNeedCookie: "未设置账号 Cookie，抓不到礼物/入场（顶部「扫码登录」后可用）", giftOn: "抓礼物 + 入场（需账号 cookie）", giftOff: "仅评论弹幕（匿名，无礼物/入场）",
      recorder: "录制器", danmuNone: "该平台暂无弹幕源（仅录视频）",
      create: "创建任务", saveEdit: "保存修改",
      created: "任务创建成功", updated: "任务已更新", createFailed: "创建失败: {msg}", updateFailed: "更新失败: {msg}",
    },
    merge: {
      title: "会话合成", combine: "合成所选（{n}）", combining: "合成中…",
      hint: "勾选要合并的会话 → 按时间序拼成一整片无损视频，对应弹幕 xml 按累计视频时长错位合并。断流分多场时用它合回完整一场。",
      noSessions: "暂无录制会话（任务未录制或输出目录为空）。", seg_one: "{count} 段", seg_other: "{count} 段", danmuOk: "弹幕 OK",
      started_one: "已开始合成 {count} 个会话…", started_other: "已开始合成 {count} 个会话…", done: "合成完成：{file}", failed: "合成失败：{msg}", startFailed: "合成启动失败：{msg}",
      jobRunning: "合成任务 {id}:进行中…", jobDone: "合成任务 {id}:完成 → {file}", jobError: "合成任务 {id}:失败：{msg}",
    },
    settings: {
      title: "设置", tabAccount: "账号", tabWebhook: "Webhook", tabEngine: "综合", tabNotif: "通知", tabAbout: "关于",
      aboutSection: "关于", aboutVersion: "版本",
      accountSection: "抖音账号 Cookie", accountHint: "扫码登录或手动粘贴 cookie。作用:抓礼物 + 入场(视频/评论匿名即可)。所有任务共享。",
      notifSection: "站内提醒", webhookSection: "全局通知 Webhook",
      webhookLabel: "Discord Webhook URL", webhookPlaceholder: "https://discord.com/api/webhooks/…（留空=关闭全局推送）",
      webhookHint: "全局兜底:任务未自带 webhook 时用它。开播/录完/合成/出错/磁盘/cookie 等告警都推到这里。(若设了 env DISCORD_WEBHOOK 或 CLI 参数,会优先于此。)",
      webhookSaved: "Webhook 已保存", webhookFailed: "保存失败: {msg}",
      mesioSection: "mesio 引擎路径", mesioLabel: "mesio 二进制路径",
      mesioHint: "仅用 mesio 引擎录制时需要。留空 = 用默认 {path}(随仓库 bin/);装到别处才需填绝对路径。改完下次起录生效。",
      mesioSaved: "mesio 路径已保存", mesioFailed: "保存失败: {msg}",
      tzSection: "时区", tzLabel: "IANA 时区名",
      tzHint: "决定定时窗口/日志时间戳按哪个时区算,由 config 决定(不看 host/容器的 TZ 环境变量)。留空 = 用默认 {default}。当前生效:{effective}。改完立即生效,不用重启。",
      tzSaved: "时区已保存", tzFailed: "保存失败: {msg}", tzInvalid: "不是合法的 IANA 时区名(如 Asia/Shanghai)",
      tzChangeConfirmTitle: "确认更改时区?",
      tzChangeConfirmMessage: "任务的定时窗口(如 22:00-01:30)是不带时区的纯文本,由当前时区解释。改时区不会改这段文本,但会让 {count} 个已设定时窗口的任务的真实启停时刻整体平移。如果只是想修正时区设置本身(主播真实开播时间没变),请改完后手动检查并调整这些任务的窗口。",
      tzChangeConfirmButton: "仍然更改",
      webhookTest: "测试", webhookTestMessage: "这是一条来自 douyin-rec 的测试信息 · 时间 {time}",
      webhookTestSent: "测试通知已发送,去 Discord 查看", webhookTestFailed: "测试失败: {msg}",
      webhookTestNoUrl: "请先保存 webhook 再测试",
    },
    notif: {
      title: "站内提醒", desc: "每类事件分别控制网页内 toast 与 Discord webhook 推送；webhook 开关默认关闭，需先配置全局 webhook 才能开启。",
      typeLabel: "事件", inAppLabel: "站内", webhookLabel: "Webhook",
      webhookLockedHint: "未配置全局 Discord webhook，webhook 开关暂不可用；请在「全局通知 Webhook」页保存 URL。",
      live: "开播 / 开始录制", recordEnd: "录制完成 / 收播", merge: "合成 / 烧录 / 上传完成", hub: "Hub 任务开始", error: "出错",
      saved: "通知设置已保存", failed: "保存失败: {msg}",
      evLive: "开播 · 开始录制：{anchor}", evRecordEnd: "录制结束{reason}：{anchor}", evMerge: "合成完成：{file}",
      evReconnect: "直播中断 {sec}s 后已重连：{anchor}",
      evBurn: "烧录完成：{file}", evUpload: "上传完成：{bv}", evHubStart: "Hub 任务开始：{room}（{count} 个节点）", evError: "出错[{stage}]：{message}",
    },
    qr: {
      title: "抖音扫码登录", desc: "用抖音 App 扫码，确认后自动获取登录 Cookie", alt: "二维码", close: "关闭",
      launching: "正在拉起浏览器并获取二维码…", fetchFailed: "获取二维码失败: {msg}", success: "扫码登录成功，Cookie 已保存", err: "错误: {msg}",
      stPending: "待扫码", stScanned: "已扫码，请在手机上确认", stConfirmed: "登录成功，已保存 Cookie", stExpired: "二维码已过期，请重试",
    },
    paste: {
      title: "手动粘贴 Cookie", desc: "全局账号 cookie,所有任务共享。作用:登录后弹幕能抓【礼物 + 入场】(视频拉流与评论弹幕匿名即可,无需 cookie)。含 sessionid 才算已登录。", placeholder: "sessionid=...; sessionid_ss=...; ttwid=...; ...",
      saved: "Cookie 已保存", saveFailed: "保存失败: {msg}", empty: "Cookie 不能为空",
      stUnset: "当前：未设置", stLoggedIn: "当前：已登录", stSetNoSession: "当前：已设置（无 sessionid）",
      expiredOn: "{base} · 登录已于 {date} 过期", validUntil: "{base} · 有效期至 {date}（剩 {days} 天）",
    },
    hub: {
      common: {
        edit: "编辑", delete: "删除", cancel: "取消", save: "保存", create: "创建",
        enabledState: "启用中", disabledState: "已暂停", loading: "加载中…",
        deleteRuleConfirmTitle: "删除该 Hub 规则?", ruleDeleted: "Hub 规则已删除",
        uploadPublicSuffix: " → 上传(公开)", uploadPrivateSuffix: " → 上传(私)", stageOnlySuffix: " → 仅合成(stage)",
      },
      page: {
        title: "Hub 管理", subtitle: "多节点选优合并 → 烧录 → 上传。按直播间配置,独立于录制任务。",
        metricRules: "规则", metricWorkers: "节点", metricActive: "进行中",
        newRule: "新建规则", noRules: "还没有 Hub 规则", viewRuns: "查看运行记录",
        colRoom: "直播间", colOutput: "产物 / 上传", colLastRun: "最近运行", colStatus: "状态", colAction: "操作",
        childTitle: "这是 child node(从节点)",
        childDesc1: "本节点未启用 hub(以 ", childDesc2: " 运行,无 ", childDesc3: ")。多节点选优合并 / 上传由 ",
        childMaster: "master 节点", childDesc4: "统一编排;Hub 规则只在 master 上配置与生效。本节点只负责录制 + 供 master 拉取。",
        roomsHeading: "直播间", selectRoomHint: "从左侧选择一个直播间查看运行记录。",
      },
      detail: {
        pipelineConfig: "后处理配置", runsHeading: "运行记录", totalRuns: "共 {count} 次",
        noRuns: "该直播间还没有 hub 运行记录(录制并收播后自动产生)。", loadMore: "加载更多（还有 {count} 次）",
        workersLabel: "参与 Worker", allWorkers: "全部节点",
        chipUploadPrivate: "上传(私)", chipUploadPublic: "上传(公开)", chipStageOnly: "仅合成",
        noRunGraph: "尚无运行(录制并收播后自动产生流程图)。",
      },
      jobs: {
        step: { pending: "排队中", settling: "等待收播", syncing: "拉取文件", merging: "合并 / 烧录", uploading: "上传 B 站", retrying: "单节点重跑", done: "已完成", failed: "失败", needsManual: "待人工" },
        stepNode: { select: "选优", pull: "拉取", merge: "合并 plain", burn_danmu: "烧 danmu", burn_livechat: "烧 livechat", upload_plain: "传 plain P1", append_danmu: "追 danmu P2", append_livechat: "追 livechat P3", clean_stage_src: "清理暂存源", clean_source: "清理节点源", clean_stage: "清理产物" },
        termDone: "完成", skipped: "跳过", noStepRecord: "（无流程记录;旧版本任务）",
        candComplete: "完整", candCoverage: "覆盖 {pct}%", candWinner: "最优",
        tipStatus: { done: "已完成", active: "进行中", skipped: "已跳过", todo: "待运行", failed: "失败", blocked: "上游失败" },
        viewLog: "查看日志", selected: "选优: {worker}", duration: "时长: {time}", retries: "已重试 {count} 次",
        runningFor: "· 已运行 {time}", etaRemaining: "· 预计剩余约 {time}",
        logTitle: "任务日志 · {key}", logEmpty: "(空)", logReadFailed: "读取日志失败(可能 stage 已清理)。", noRunYet: "尚无运行",
        retryNode: "重跑此节点", retryNodeConfirmTitle: "重跑上传节点?", retryNodeConfirmMessage: "该节点已产生远端副作用(建稿/追加分 P)。若上一次实际已成功，重跑会重复投稿。确认要继续吗?",
        stop: "停止", stopTitle: "停止后处理", stopped: "已停止后处理",
        runNow: "立即执行", runNowTitle: "立即执行后处理", runNowDesc: "跳过收播等待，立刻用已有录像跑合并 / 烧录 / 上传。",
        runNowDate: "场次", runNowCustom: "自定义日期", runNowDateHint: "YYYY-MM-DD",
        runNowWorker: "选优节点", runNowWorkerAuto: "自动选优",
        started: "已启动后处理", rerun: "重跑此场",
      },
      ruleDialog: {
        createTitle: "新建 Hub 规则", editTitle: "编辑 Hub 规则", desc: "按直播间配置多节点选优合并 → 烧录 → 上传的后处理流程",
        roomLabel: "直播间地址 / room", roomSlugSuffix: "(roomSlug: {slug})",
        roomFromTaskLabel: "房间 / room（取自所选 master 任务）", roomFromTaskHint: "选择下面的 master 任务后自动填充",
        enabledLabel: "规则启用 / enabled", enabledHint: "关闭 = hub 暂停处理此房间(录制不受影响)",
        pipelineSection: "流水线 / pipeline",
        toggleBurnDanmuLabel: "烧 danmu / 飞屏弹幕", toggleBurnDanmuSub: "合成飞屏弹幕版",
        toggleBurnLivechatLabel: "烧 livechat / 聊天框", toggleBurnLivechatSub: "合成聊天框版",
        toggleClStageSourceAfterMergeLabel: "合并后删 stage 源 .ts", toggleClStageSourceAfterMergeSub: "留合成产物,删拉来的源片",
        toggleClSourceAfterDoneLabel: "完成后删源节点录制", toggleClSourceAfterDoneSub: "各节点原始 .ts(完成后)",
        toggleClStageAfterDoneLabel: "完成后删 stage 产物", toggleClStageAfterDoneSub: "上传后删合成 mp4",
        toggleClIncludeXmlAssLabel: "删除含 .xml/.ass", toggleClIncludeXmlAssSub: "默认只删 .ts/.mp4(守弹幕源)",
        uploadSection: "Bilibili 上传 / upload", uploadToggleLabel: "上传 B站 / bilibili upload",
        uploadOnHint: "合成后自动投稿(关水印·copyright 自制)", uploadOffHint: "只合成,不上传(留 stage 待人工)",
        publicLabel: "公开 / public", privateHint: "仅自己可见(默认)", publicHint: "公开投稿",
        tidLabel: "B站分区 tid", tagLabel: "B站 tag(逗号分隔)", tagPlaceholder: "直播,录像,…",
        descLabel: "B站简介 desc", descPlaceholder: "(可选,支持多行)",
        workersSection: "参与 Worker / workers",
        workersHint: "只对勾选的 worker 的录像做选优合并上传;不勾 = 忽略该 worker。至少选 1 个。",
        workersEmpty: "还没有配置 Worker,请先在 Workers 页添加。",
        workersLoadFailed: "加载 Worker 列表失败,请重试。",
        workersRequired: "请至少选择一个 Worker",
        recordingSection: "录制下发 / recording",
        recordingHint: "房间与房间号取自所选 master 任务；任务会自动同步到勾选的 Worker 节点（节点上不可编辑/删除）",
        sourceTaskLabel: "绑定 master 任务 / source task",
        sourceTaskChoose: "请选择要绑定的 master 任务",
        sourceTaskRequired: "请先选择要绑定的 master 任务",
        sourceTaskNone: "未绑定（只做后处理）",
        sourceTasksEmpty: "没有可绑定的录制任务，请先在任务页创建",
        tasksLoadFailed: "加载任务列表失败，请重试",
        created: "Hub 规则已创建", updated: "Hub 规则已更新",
      },
      workers: {
        title: "Workers / 录制节点", subtitle: "选优合并的数据来源,local = master 自身。", add: "添加 Worker",
        colName: "名称", colKind: "类型", colHost: "host", colStatus: "状态", colAction: "操作",
        empty: "还没有 Worker", testConn: "测试连接", deleteConfirmTitle: "删除该 Worker?", deleted: "Worker 已删除",
        statusOk: "在线 · dataRoot 可达", statusChecking: "检测中…",
        pill: "Workers · {count}", close: "关闭 Workers 面板", statusFail: "离线", statusMixed: "部分离线",
      },
      workerDialog: {
        createTitle: "新建 Worker", editTitle: "编辑 Worker", desc: "录制节点(选优合并的数据来源)",
        idLabel: "id: {id}", nameLabel: "名称 / name", namePlaceholder: "友好名(留空则用 host)",
        kindLabel: "类型 / kind", localKindHint: "master 自身,类型不可改",
        hostLabel: "host", hostPlaceholder: "100.x.y.z 或 host.ts.net",
        dataRootLabel: "dataRoot", dataRootPlaceholder: "/home/ubuntu/drec 或 /data",
        testOk: "连接成功 · dataRoot 可达", testFailed: "连接失败:{error}", unknownError: "未知错误",
        created: "Worker 已创建", updated: "Worker 已更新",
      },
    },
  },
  en: {
    common: { cancel: "Cancel", confirm: "Confirm", save: "Save", delete: "Delete", refresh: "Refresh", close: "Close", optional: "optional", on: "On", off: "Off", yes: "Yes", no: "No", localTimeTooltip: "Current timezone: {serverTz}\nYour local time: {local}" },
    nav: { title: "Douyin Recorder", tasksList: "Tasks", login: "QR Login", paste: "Paste Cookie", clear: "Clear", notif: "Notification settings" },
    theme: { toDark: "Switch to dark", toLight: "Switch to light", darkMode: "Dark mode", lightMode: "Light mode" },
    cookie: {
      checking: "Checking…", loggedIn: "Logged in", expired: "Login expired", expiresIn: "{days}d left",
      loggedInDays: "Logged in · {days}d left", noSession: "No session", notSet: "Not set",
      clearConfirm: "Clear the global cookie? All tasks will connect anonymously.", cleared: "Global cookie cleared", clearFailed: "Clear failed: {msg}",
    },
    footer: { tagline: "Douyin live recording · danmu capture · post-processing" },
    tasks: {
      empty: "No tasks", add: "New task", room: "Room", openLive: "Open live room", anchor: "Streamer", quality: "Quality", recorder: "Recorder",
      danmu: "Danmu", schedule: "Schedule", giftCookie: "Gift cookie",
      outDir: "Output dir", startedAt: "Started", elapsed: "Elapsed", logs: "Logs", info: "Task info",
      managed: "Hub managed", managedHint: "Managed and synced by hub; edit on master",
      start: "Start", stop: "Stop", edit: "Edit", backToList: "Task list", noLogs: "No logs (task not running or no output)",
      lines_one: "{count} line", lines_other: "{count} lines", started: "Task {id} started", stopped: "Task {id} stopped", deleted: "Task {id} deleted",
      startFailed: "Start failed: {msg}", stopFailed: "Stop failed: {msg}", deleteFailed: "Delete failed: {msg}",
      deleteConfirm: "Delete task {id}?", unavailable: "Task unavailable, back to list", stopFirst: "Stop the task before deleting",
      pageTitle: "Recording tasks", pageSubtitle: "Multi-task live recording · danmu · scheduling · list auto-refreshes every 2s",
      metricTotal: "Total", metricRecording: "Recording", metricWaiting: "Standby", metricError: "Errors",
      connected: "Connected · {time}", connFailed: "Disconnected", loading: "Loading…", noneYet: "No tasks yet",
      colName: "Name / Room", colQuality: "Quality", colDanmu: "Danmu", colSchedule: "Schedule", colStatus: "Status", colAction: "Actions",
      scheduleLocalTooltip: "Current timezone: {serverTz}\nYour local window: {local}",
      titleStart: "Start (enable)", titleStop: "Stop (disable)", titleDetail: "Details", titleEdit: "Edit",
    },
    badge: { disabled: "Disabled", draining: "Draining", recording: "Recording", waiting: "Waiting", idle: "Idle", error: "Error" },
    danmuKind: { off: "Off", gift: "Gifts", anon: "Anonymous" },
    dialog: {
      createTitle: "New recording task", editTitle: "Edit task", desc: "Set the room and recording options. The global cookie is managed at the top-right.",
      platform: "Platform: {id}",
      runningWarn: "Running task: changes are saved to the DB and take effect on next start.",
      room: "Room (id or URL)", roomPlaceholder: "36464127515 or https://live.douyin.com/...",
      name: "Streamer name", namePlaceholder: "optional, auto-detected", quality: "Quality",
      segment: "Segment seconds (0 = no split)", scheduleWindow: "Schedule window (server timezone)",
      schedulePlaceholder: "optional, e.g. 22:30-01:00 (overnight ok)", schedHint: "Judged by the server's configured timezone (now {now}{tz}); overnight windows like 22:30-01:00 supported.",
      webhook: "Notify Webhook (Discord)", webhookPlaceholder: "optional, empty = fall back to global",
      webhookHint: "Per-task: live start / recording done / merge done / errors are pushed to this Discord webhook. Empty uses the global setting.",
      recDanmu: "Record danmu", danmuGift: "Danmu with gifts + entries",
      giftNeedCookie: "No account cookie; gifts/entries unavailable (use QR Login at top)", giftOn: "Capture gifts + entries (needs cookie)", giftOff: "Comments only (anonymous; no gifts/entries)",
      recorder: "Recorder", danmuNone: "This platform has no danmu source (video only)",
      create: "Create", saveEdit: "Save changes",
      created: "Task created", updated: "Task updated", createFailed: "Create failed: {msg}", updateFailed: "Update failed: {msg}",
    },
    merge: {
      title: "Merge sessions", combine: "Merge selected ({n})", combining: "Merging…",
      hint: "Pick sessions → losslessly concatenate into one video in time order; the danmu xml is merged with cumulative video-time offsets. Use it to rejoin a split (reconnected) stream.",
      noSessions: "No recorded sessions (task hasn't recorded or output dir is empty).", seg_one: "{count} seg", seg_other: "{count} segs", danmuOk: "danmu OK",
      started_one: "Merging {count} session…", started_other: "Merging {count} sessions…", done: "Merge done: {file}", failed: "Merge failed: {msg}", startFailed: "Failed to start merge: {msg}",
      jobRunning: "Merge {id}: running…", jobDone: "Merge {id}: done → {file}", jobError: "Merge {id}: failed: {msg}",
    },
    settings: {
      title: "Settings", tabAccount: "Account", tabWebhook: "Webhook", tabEngine: "General", tabNotif: "Notifications", tabAbout: "About",
      aboutSection: "About", aboutVersion: "Version",
      accountSection: "Douyin account cookie", accountHint: "QR-login or paste a cookie. Used to capture gifts + entries (video/comments work anonymously). Shared by all tasks.",
      notifSection: "In-app notifications", webhookSection: "Global notification webhook",
      webhookLabel: "Discord Webhook URL", webhookPlaceholder: "https://discord.com/api/webhooks/… (empty = disable global push)",
      webhookHint: "Global fallback: used when a task has no own webhook. Live-start / recording-done / merge / errors / disk / cookie alerts all push here. (env DISCORD_WEBHOOK or CLI flag takes precedence if set.)",
      webhookSaved: "Webhook saved", webhookFailed: "Save failed: {msg}",
      mesioSection: "mesio engine path", mesioLabel: "mesio binary path",
      mesioHint: "Only needed when recording with the mesio engine. Empty = use default {path} (repo bin/); set an absolute path only if mesio is installed elsewhere. Takes effect on next recording start.",
      mesioSaved: "mesio path saved", mesioFailed: "Save failed: {msg}",
      tzSection: "Timezone", tzLabel: "IANA timezone name",
      tzHint: "Controls what timezone schedule windows / log timestamps use, driven by config (ignores host/container TZ env var). Empty = use default {default}. Currently effective: {effective}. Takes effect immediately, no restart needed.",
      tzSaved: "Timezone saved", tzFailed: "Save failed: {msg}", tzInvalid: "Not a valid IANA timezone name (e.g. Asia/Shanghai)",
      tzChangeConfirmTitle: "Change timezone?",
      tzChangeConfirmMessage: "A task's schedule window (e.g. 22:00-01:30) is plain text with no timezone attached. It's interpreted using whatever timezone is currently active. Changing the timezone won't touch that text, but it will shift the actual real-world start/stop moment for {count} task(s) that have a schedule window set. If you're only correcting the timezone setting itself (the streamer's actual live time hasn't changed), review and adjust those tasks' windows afterward.",
      tzChangeConfirmButton: "Change anyway",
      webhookTest: "Test", webhookTestMessage: "Test message from douyin-rec · time {time}",
      webhookTestSent: "Test notification sent - check Discord", webhookTestFailed: "Test failed: {msg}",
      webhookTestNoUrl: "Save the webhook first, then test",
    },
    notif: {
      title: "In-app notifications", desc: "Control toast and Discord webhook pushes per event type. Webhook switches are off by default and only become available after a global webhook is configured.",
      typeLabel: "Event", inAppLabel: "In-app", webhookLabel: "Webhook",
      webhookLockedHint: "No global Discord webhook configured. Save a URL on the Global notification webhook tab to enable these switches.",
      live: "Live start / recording", recordEnd: "Recording done", merge: "Merge / burn / upload done", hub: "Hub task started", error: "Errors",
      saved: "Notification settings saved", failed: "Save failed: {msg}",
      evLive: "Live · recording started: {anchor}", evRecordEnd: "Recording ended{reason}: {anchor}", evMerge: "Merge done: {file}",
      evReconnect: "Reconnected after {sec}s interruption: {anchor}",
      evBurn: "Burn done: {file}", evUpload: "Upload done: {bv}", evHubStart: "Hub task started: {room} ({count} nodes)", evError: "Error[{stage}]: {message}",
    },
    qr: {
      title: "Douyin QR Login", desc: "Scan with the Douyin app; the cookie is fetched after you confirm.", alt: "QR code", close: "Close",
      launching: "Launching browser and fetching QR…", fetchFailed: "Failed to get QR: {msg}", success: "QR login OK, cookie saved", err: "Error: {msg}",
      stPending: "Awaiting scan", stScanned: "Scanned, confirm on your phone", stConfirmed: "Logged in, cookie saved", stExpired: "QR expired, retrying",
    },
    paste: {
      title: "Paste cookie", desc: "Global account cookie, shared by all tasks. Purpose: once logged in, danmu can capture [gifts + entries] (video pull and comment danmu work anonymously, no cookie needed). A sessionid means logged in.", placeholder: "sessionid=...; sessionid_ss=...; ttwid=...; ...",
      saved: "Cookie saved", saveFailed: "Save failed: {msg}", empty: "Cookie cannot be empty",
      stUnset: "Current: not set", stLoggedIn: "Current: logged in", stSetNoSession: "Current: set (no sessionid)",
      expiredOn: "{base} · login expired on {date}", validUntil: "{base} · valid until {date} ({days}d left)",
    },
    hub: {
      common: {
        edit: "Edit", delete: "Delete", cancel: "Cancel", save: "Save", create: "Create",
        enabledState: "Enabled", disabledState: "Paused", loading: "Loading…",
        deleteRuleConfirmTitle: "Delete this Hub rule?", ruleDeleted: "Hub rule deleted",
        uploadPublicSuffix: " → Upload (public)", uploadPrivateSuffix: " → Upload (private)", stageOnlySuffix: " → Stage only",
      },
      page: {
        title: "Hub", subtitle: "Multi-node selection → merge → burn → upload. Configured per room, independent of recording tasks.",
        metricRules: "Rules", metricWorkers: "Workers", metricActive: "Active",
        newRule: "New rule", noRules: "No Hub rules yet", viewRuns: "View run history",
        colRoom: "Room", colOutput: "Output / upload", colLastRun: "Last run", colStatus: "Status", colAction: "Actions",
        childTitle: "This is a child node",
        childDesc1: "Hub isn't enabled on this node (running ", childDesc2: " without ", childDesc3: "). Multi-node selection/merge/upload is orchestrated entirely by the ",
        childMaster: "master node", childDesc4: "; Hub rules are only configured and take effect on master. This node only records and lets master pull from it.",
        roomsHeading: "Rooms", selectRoomHint: "Select a room on the left to view its run history.",
      },
      detail: {
        pipelineConfig: "Post-processing config", runsHeading: "Run history", totalRuns: "{count} runs total",
        noRuns: "No hub runs yet for this room (created automatically after recording ends).", loadMore: "Load more ({count} remaining)",
        workersLabel: "Participating workers", allWorkers: "All nodes",
        chipUploadPrivate: "Upload (private)", chipUploadPublic: "Upload (public)", chipStageOnly: "Stage only",
        noRunGraph: "No runs yet (a pipeline graph appears automatically after recording ends).",
      },
      jobs: {
        step: { pending: "Queued", settling: "Waiting for stream to end", syncing: "Pulling files", merging: "Merging / burning", uploading: "Uploading to Bilibili", retrying: "Retrying node", done: "Done", failed: "Failed", needsManual: "Needs review" },
        stepNode: { select: "Select", pull: "Pull", merge: "Merge plain", burn_danmu: "Burn danmu", burn_livechat: "Burn livechat", upload_plain: "Upload plain P1", append_danmu: "Append danmu P2", append_livechat: "Append livechat P3", clean_stage_src: "Clean staged src", clean_source: "Clean node src", clean_stage: "Clean products" },
        termDone: "Done", skipped: "Skipped", noStepRecord: "(no step record; legacy job)",
        candComplete: "complete", candCoverage: "{pct}% cover", candWinner: "winner",
        tipStatus: { done: "Done", active: "In progress", skipped: "Skipped", todo: "Pending", failed: "Failed", blocked: "Upstream failed" },
        viewLog: "View log", selected: "Winner: {worker}", duration: "Duration: {time}", retries: "Retried {count} times",
        runningFor: "· running {time}", etaRemaining: "· ~{time} remaining",
        logTitle: "Job log · {key}", logEmpty: "(empty)", logReadFailed: "Failed to read log (stage may have been cleaned up).", noRunYet: "No runs yet",
        retryNode: "Retry node", retryNodeConfirmTitle: "Retry upload node?", retryNodeConfirmMessage: "This node has remote side effects (created submission / appended parts). If the previous attempt actually succeeded, retrying will create a duplicate. Continue?",
        stop: "Stop", stopTitle: "Stop post-process", stopped: "Post-process stopped",
        runNow: "Run now", runNowTitle: "Run post-process now", runNowDesc: "Skip the settle / reconnect wait and run merge / burn / upload on existing recordings.",
        runNowDate: "Broadcast", runNowCustom: "Custom date", runNowDateHint: "YYYY-MM-DD",
        runNowWorker: "Winner node", runNowWorkerAuto: "Auto-select",
        started: "Post-process started", rerun: "Rerun this broadcast",
      },
      ruleDialog: {
        createTitle: "New Hub rule", editTitle: "Edit Hub rule", desc: "Configure the multi-node select → merge → burn → upload pipeline for this room",
        roomLabel: "Room", roomSlugSuffix: " (roomSlug: {slug})",
        roomFromTaskLabel: "Room (from selected source task)", roomFromTaskHint: "Pick the source task below; the room is filled in automatically.",
        enabledLabel: "Rule enabled", enabledHint: "Off = hub pauses processing for this room (recording unaffected)",
        pipelineSection: "Pipeline",
        toggleBurnDanmuLabel: "Burn danmu / scrolling", toggleBurnDanmuSub: "Produce the scrolling-danmu cut",
        toggleBurnLivechatLabel: "Burn livechat / chat panel", toggleBurnLivechatSub: "Produce the chat-panel cut",
        toggleClStageSourceAfterMergeLabel: "Delete staged source .ts after merge", toggleClStageSourceAfterMergeSub: "Keep the merged output, delete the pulled source",
        toggleClSourceAfterDoneLabel: "Delete source-node recordings when done", toggleClSourceAfterDoneSub: "Original .ts on each node (after done)",
        toggleClStageAfterDoneLabel: "Delete staged output when done", toggleClStageAfterDoneSub: "Delete merged mp4 after upload",
        toggleClIncludeXmlAssLabel: "Also delete .xml/.ass", toggleClIncludeXmlAssSub: "Default only deletes .ts/.mp4 (keeps danmu sources)",
        uploadSection: "Bilibili upload", uploadToggleLabel: "Upload to Bilibili",
        uploadOnHint: "Auto-submit after merging (watermark off, copyright: self-made)", uploadOffHint: "Merge only, no upload (left staged for manual review)",
        publicLabel: "Public", privateHint: "Private (default)", publicHint: "Public submission",
        tidLabel: "Bilibili partition tid", tagLabel: "Bilibili tags (comma-separated)", tagPlaceholder: "live, replay, …",
        descLabel: "Bilibili description", descPlaceholder: "(optional, multi-line)",
        workersSection: "Participating workers",
        workersHint: "Only selected workers' recordings are selected / merged / uploaded; unchecked = ignore that worker. Pick at least one.",
        workersEmpty: "No workers configured yet. Add one on the Workers page first.",
        workersLoadFailed: "Failed to load workers, please retry.",
        workersRequired: "Select at least one worker",
        recordingSection: "Recording dispatch",
        recordingHint: "The room and roomSlug come from the selected master task, which is synced to the chosen worker nodes (not editable/deletable there)",
        sourceTaskLabel: "Source task",
        sourceTaskChoose: "Select a source task",
        sourceTaskRequired: "Select a source task first",
        sourceTaskNone: "Not bound (post-processing only)",
        sourceTasksEmpty: "No recordable tasks yet. Create one on the Tasks page first.",
        tasksLoadFailed: "Failed to load tasks, please retry",
        created: "Hub rule created", updated: "Hub rule updated",
      },
      workers: {
        title: "Workers / recording nodes", subtitle: "Data sources for selection & merge; local = master itself.", add: "Add worker",
        colName: "Name", colKind: "Kind", colHost: "Host", colStatus: "Status", colAction: "Actions",
        empty: "No workers yet", testConn: "Test connection", deleteConfirmTitle: "Delete this worker?", deleted: "Worker deleted",
        statusOk: "Online · dataRoot reachable", statusChecking: "Checking…",
        pill: "Workers · {count}", close: "Close Workers panel", statusFail: "Offline", statusMixed: "Some offline",
      },
      workerDialog: {
        createTitle: "New worker", editTitle: "Edit worker", desc: "Recording node (a data source for selection & merge)",
        idLabel: "id: {id}", nameLabel: "Name", namePlaceholder: "Friendly name (defaults to host)",
        kindLabel: "Kind", localKindHint: "Master itself, kind can't be changed",
        hostLabel: "Host", hostPlaceholder: "100.x.y.z or host.ts.net",
        dataRootLabel: "dataRoot", dataRootPlaceholder: "/home/ubuntu/drec or /data",
        testOk: "Connected · dataRoot reachable", testFailed: "Connection failed: {error}", unknownError: "Unknown error",
        created: "Worker created", updated: "Worker updated",
      },
    },
  },
};

// 模块加载即初始化(main.tsx import 本文件触发)。单花括号插值 {var};escapeValue=false(React 已转义)。
void i18next.use(initReactI18next).init({
  resources: { zh: { translation: DICT.zh }, en: { translation: DICT.en } },
  lng: detectInitial(),
  fallbackLng: "zh",
  interpolation: { prefix: "{", suffix: "}", escapeValue: false },
});

export default i18next;
