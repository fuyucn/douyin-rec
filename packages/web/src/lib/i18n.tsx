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
    common: { cancel: "取消", confirm: "确定", save: "保存", delete: "删除", refresh: "刷新", close: "关闭", optional: "可选", on: "开", off: "关", yes: "是", no: "否" },
    nav: { title: "抖音录制控制台", login: "扫码登录", paste: "手动粘贴", clear: "清除", notif: "站内提醒设置" },
    cookie: {
      checking: "检查中…", loggedIn: "✅ 已登录", expired: "⚠️ 登录已过期", expiresIn: "⚠️ 剩 {days} 天过期",
      loggedInDays: "✅ 已登录 · 剩 {days} 天", noSession: "⚠️ 无 session", notSet: "⚠️ 未设置",
      clearConfirm: "清除全局 Cookie？所有任务将变为匿名连接。", cleared: "全局 Cookie 已清除", clearFailed: "清除失败: {msg}",
    },
    footer: { tagline: "抖音直播录制 · 弹幕捕获 · 后处理" },
    tasks: {
      empty: "暂无任务", add: "新建任务", room: "房间", openLive: "打开直播间", anchor: "主播", quality: "画质", recorder: "直播 provider",
      danmu: "弹幕", schedule: "定时窗口", giftCookie: "含礼物 cookie",
      outDir: "输出目录", startedAt: "开始时间", elapsed: "已录时长", logs: "日志", info: "任务信息",
      start: "启动", stop: "停止", edit: "编辑", backToList: "任务列表", noLogs: "暂无日志（任务未运行或无输出）",
      lines_one: "{count} 行", lines_other: "{count} 行", started: "任务 {id} 已启动", stopped: "任务 {id} 已停止", deleted: "任务 {id} 已删除",
      startFailed: "启动失败: {msg}", stopFailed: "停止失败: {msg}", deleteFailed: "删除失败: {msg}",
      deleteConfirm: "删除任务 {id}？", unavailable: "任务不可用，返回列表", stopFirst: "请先停止任务再删除",
      pageTitle: "录制任务", pageSubtitle: "多任务直播流录制 · 弹幕 · 定时调度 · 列表每 2 秒自动刷新",
      connected: "已连接 · {time}", connFailed: "连接失败", loading: "加载中…", noneYet: "还没有任务",
      colName: "名称 / 房间", colQuality: "画质", colDanmu: "弹幕", colSchedule: "定时", colStatus: "状态", colAction: "操作",
      titleStart: "启动（启用）", titleStop: "停止（停用）", titleDetail: "详情", titleEdit: "编辑",
    },
    status: { stopped: "○ 待命", recording: "● 录制中", waiting: "◌ 等待开播", draining: "⏳ 超窗录制中", error: "✗ 错误", disabled: "○ 已停用" },
    badge: { disabled: "已停用", draining: "⏳ 排空中", recording: "录制中", waiting: "⏳ 等待开播中", idle: "已启用·待命", error: "错误" },
    danmuKind: { off: "关闭", gift: "含礼物", anon: "匿名" },
    dialog: {
      createTitle: "新建录制任务", editTitle: "编辑任务", desc: "填写直播间与录制参数，全局 Cookie 在右上角统一管理。",
      runningWarn: "⚠️ 运行中任务：修改将保存到数据库，下次启动生效。",
      room: "直播间（房间号或 URL）", roomPlaceholder: "36464127515 或 https://live.douyin.com/...",
      name: "主播名称", namePlaceholder: "可选，自动获取", quality: "画质",
      segment: "分段时长（秒，0 = 不分段）", scheduleWindow: "定时窗口（本地时间）",
      schedulePlaceholder: "可选，如 22:30-01:00（支持跨夜）", schedHint: "按服务端配置的时区判断（现在 {now}{tz}），支持跨夜窗口如 22:30-01:00。",
      schedHintLocalTooltip: "你的本地时间：{local}",
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
      noSessions: "暂无录制会话（任务未录制或输出目录为空）。", seg_one: "{count} 段", seg_other: "{count} 段", danmuOk: "弹幕✓",
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
      webhookTest: "测试", webhookTestMessage: "🔔 这是一条来自 douyin-rec 的测试信息 · 时间 {time}",
      webhookTestSent: "测试通知已发送,去 Discord 查看", webhookTestFailed: "测试失败: {msg}",
      webhookTestNoUrl: "请先保存 webhook 再测试",
    },
    notif: {
      title: "站内提醒", desc: "选择哪些事件在网页内弹出提醒。Discord 推送由各任务的 Webhook 单独控制，不受此处影响。",
      live: "开播 / 开始录制", recordEnd: "录制完成 / 收播", merge: "合成 / 烧录 / 上传完成", error: "出错",
      evLive: "开播 · 开始录制：{anchor}", evRecordEnd: "录制结束{reason}：{anchor}", evMerge: "合成完成：{file}",
      evReconnect: "直播中断 {sec}s 后已重连：{anchor}",
      evBurn: "烧录完成：{file}", evUpload: "上传完成：{bv}", evError: "出错[{stage}]：{message}",
    },
    qr: {
      title: "抖音扫码登录", desc: "用抖音 App 扫码，确认后自动获取登录 Cookie", alt: "二维码", close: "关闭",
      launching: "正在拉起浏览器并获取二维码…", fetchFailed: "获取二维码失败: {msg}", success: "扫码登录成功，Cookie 已保存", err: "错误: {msg}",
      stPending: "待扫码", stScanned: "已扫码，请在手机上确认", stConfirmed: "✅ 登录成功，已保存 Cookie", stExpired: "二维码已过期，请重试",
    },
    paste: {
      title: "手动粘贴 Cookie", desc: "全局账号 cookie,所有任务共享。作用:登录后弹幕能抓【礼物 + 入场】(视频拉流与评论弹幕匿名即可,无需 cookie)。含 sessionid 才算已登录。", placeholder: "sessionid=...; sessionid_ss=...; ttwid=...; ...",
      saved: "Cookie 已保存", saveFailed: "保存失败: {msg}", empty: "Cookie 不能为空",
      stUnset: "当前：未设置", stLoggedIn: "当前：已登录", stSetNoSession: "当前：已设置（无 sessionid）",
      expiredOn: "{base} · 登录已于 {date} 过期", validUntil: "{base} · 有效期至 {date}（剩 {days} 天）",
    },
  },
  en: {
    common: { cancel: "Cancel", confirm: "Confirm", save: "Save", delete: "Delete", refresh: "Refresh", close: "Close", optional: "optional", on: "On", off: "Off", yes: "Yes", no: "No" },
    nav: { title: "Douyin Recorder", login: "QR Login", paste: "Paste Cookie", clear: "Clear", notif: "Notification settings" },
    cookie: {
      checking: "Checking…", loggedIn: "✅ Logged in", expired: "⚠️ Login expired", expiresIn: "⚠️ {days}d left",
      loggedInDays: "✅ Logged in · {days}d left", noSession: "⚠️ No session", notSet: "⚠️ Not set",
      clearConfirm: "Clear the global cookie? All tasks will connect anonymously.", cleared: "Global cookie cleared", clearFailed: "Clear failed: {msg}",
    },
    footer: { tagline: "Douyin live recording · danmu capture · post-processing" },
    tasks: {
      empty: "No tasks", add: "New task", room: "Room", openLive: "Open live room", anchor: "Streamer", quality: "Quality", recorder: "Recorder",
      danmu: "Danmu", schedule: "Schedule", giftCookie: "Gift cookie",
      outDir: "Output dir", startedAt: "Started", elapsed: "Elapsed", logs: "Logs", info: "Task info",
      start: "Start", stop: "Stop", edit: "Edit", backToList: "Task list", noLogs: "No logs (task not running or no output)",
      lines_one: "{count} line", lines_other: "{count} lines", started: "Task {id} started", stopped: "Task {id} stopped", deleted: "Task {id} deleted",
      startFailed: "Start failed: {msg}", stopFailed: "Stop failed: {msg}", deleteFailed: "Delete failed: {msg}",
      deleteConfirm: "Delete task {id}?", unavailable: "Task unavailable, back to list", stopFirst: "Stop the task before deleting",
      pageTitle: "Recording tasks", pageSubtitle: "Multi-task live recording · danmu · scheduling · list auto-refreshes every 2s",
      connected: "Connected · {time}", connFailed: "Disconnected", loading: "Loading…", noneYet: "No tasks yet",
      colName: "Name / Room", colQuality: "Quality", colDanmu: "Danmu", colSchedule: "Schedule", colStatus: "Status", colAction: "Actions",
      titleStart: "Start (enable)", titleStop: "Stop (disable)", titleDetail: "Details", titleEdit: "Edit",
    },
    status: { stopped: "○ Idle", recording: "● Recording", waiting: "◌ Waiting", draining: "⏳ Over-window", error: "✗ Error", disabled: "○ Disabled" },
    badge: { disabled: "Disabled", draining: "⏳ Draining", recording: "Recording", waiting: "⏳ Waiting", idle: "Idle", error: "Error" },
    danmuKind: { off: "Off", gift: "Gifts", anon: "Anonymous" },
    dialog: {
      createTitle: "New recording task", editTitle: "Edit task", desc: "Set the room and recording options. The global cookie is managed at the top-right.",
      runningWarn: "⚠️ Running task: changes are saved to the DB and take effect on next start.",
      room: "Room (id or URL)", roomPlaceholder: "36464127515 or https://live.douyin.com/...",
      name: "Streamer name", namePlaceholder: "optional, auto-detected", quality: "Quality",
      segment: "Segment seconds (0 = no split)", scheduleWindow: "Schedule window (local time)",
      schedulePlaceholder: "optional, e.g. 22:30-01:00 (overnight ok)", schedHint: "Judged by the server's configured timezone (now {now}{tz}); overnight windows like 22:30-01:00 supported.",
      schedHintLocalTooltip: "Your local time: {local}",
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
      noSessions: "No recorded sessions (task hasn't recorded or output dir is empty).", seg_one: "{count} seg", seg_other: "{count} segs", danmuOk: "danmu✓",
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
      webhookTest: "Test", webhookTestMessage: "🔔 Test message from douyin-rec · time {time}",
      webhookTestSent: "Test notification sent — check Discord", webhookTestFailed: "Test failed: {msg}",
      webhookTestNoUrl: "Save the webhook first, then test",
    },
    notif: {
      title: "In-app notifications", desc: "Choose which events pop a toast in the web UI. Discord pushes are controlled per-task by each Webhook, unaffected here.",
      live: "Live start / recording", recordEnd: "Recording done", merge: "Merge / burn / upload done", error: "Errors",
      evLive: "Live · recording started: {anchor}", evRecordEnd: "Recording ended{reason}: {anchor}", evMerge: "Merge done: {file}",
      evReconnect: "Reconnected after {sec}s interruption: {anchor}",
      evBurn: "Burn done: {file}", evUpload: "Upload done: {bv}", evError: "Error[{stage}]: {message}",
    },
    qr: {
      title: "Douyin QR Login", desc: "Scan with the Douyin app; the cookie is fetched after you confirm.", alt: "QR code", close: "Close",
      launching: "Launching browser and fetching QR…", fetchFailed: "Failed to get QR: {msg}", success: "QR login OK, cookie saved", err: "Error: {msg}",
      stPending: "Awaiting scan", stScanned: "Scanned, confirm on your phone", stConfirmed: "✅ Logged in, cookie saved", stExpired: "QR expired, retrying",
    },
    paste: {
      title: "Paste cookie", desc: "Global account cookie, shared by all tasks. Purpose: once logged in, danmu can capture [gifts + entries] (video pull and comment danmu work anonymously, no cookie needed). A sessionid means logged in.", placeholder: "sessionid=...; sessionid_ss=...; ttwid=...; ...",
      saved: "Cookie saved", saveFailed: "Save failed: {msg}", empty: "Cookie cannot be empty",
      stUnset: "Current: not set", stLoggedIn: "Current: logged in", stSetNoSession: "Current: set (no sessionid)",
      expiredOn: "{base} · login expired on {date}", validUntil: "{base} · valid until {date} ({days}d left)",
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
