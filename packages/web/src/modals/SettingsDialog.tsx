import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ClipboardPaste } from "lucide-react";
import { api, type HubResources } from "../api/client";
import { cookieStatusAtom, serverTimezoneAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { errMessage, useRefreshCookie, useToast } from "../lib/hooks";
import { useT, useLang } from "../lib/i18n";
import { getToggles, setToggle, NOTIF_KEYS, type NotifKey } from "../lib/notifications";
import type { BiliupAuthStatus, CookieStatus, NotifWebhookToggles } from "@drec/contracts";

type Tab = "account" | "engine" | "notif" | "resources" | "about";

/**
 * 资源闸门可调项(表驱动,而不是手写 8 份 JSX)。
 * min 必须与后端 hub-config-store 的 validateResources **完全一致** ——
 * 前端拦一道只是少一次往返,后端才是权威;两边不一致会出现「前端允许、后端 400」。
 */
const RESOURCE_FIELDS: Array<{
  key: keyof HubResources;
  min: number;
  label: string;
  hint: string;
}> = [
  { key: "maxCpuParallel", min: 1, label: "settings.resCpu", hint: "settings.resCpuHint" },
  { key: "maxNetParallel", min: 0, label: "settings.resNet", hint: "settings.resNetHint" },
  { key: "maxConcurrentPipelines", min: 1, label: "settings.resPipelines", hint: "settings.resPipelinesHint" },
  { key: "minBurnFreeMemMB", min: 0, label: "settings.resMem", hint: "settings.resMemHint" },
  { key: "memWaitTimeoutMs", min: 0, label: "settings.resMemWait", hint: "settings.resMemWaitHint" },
  { key: "uploadRateLimit", min: 1, label: "settings.resRateLimit", hint: "settings.resRateLimitHint" },
  { key: "uploadRateWindowMs", min: 1, label: "settings.resRateWindow", hint: "settings.resRateWindowHint" },
  { key: "uploadCooldownMs", min: 0, label: "settings.resCooldown", hint: "settings.resCooldownHint" },
];

/** 固定几个常用大时区(够用即可,不需要全量 IANA 列表)。 */
const TIMEZONE_OPTIONS = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "UTC",
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** 打开扫码登录 / 手动粘贴(对话框由 TopNav 渲染,这里只触发)。 */
  onOpenQr: (platform: string) => void;
  onOpenPaste: (platform: string) => void;
}

/** 设置:分类 tabs —— 账号 Cookie(扫码/粘贴/清除)/ 全局 Webhook / 站内提醒开关。 */
export function SettingsDialog({ open, onClose, onOpenQr, onOpenPaste }: Props): ReactNode {
  const t = useT();
  const [lang, setLang] = useLang();
  const toast = useToast();
  const refreshCookie = useRefreshCookie();
  const douyinCookie = useAtomValue(cookieStatusAtom);
  const [cookieStatuses, setCookieStatuses] = useState<CookieStatus[]>([]);
  const [biliupAuth, setBiliupAuth] = useState<BiliupAuthStatus | null>(null);
  const setServerTimezone = useSetAtom(serverTimezoneAtom);
  const [tab, setTab] = useState<Tab>("engine");
  const [toggles, setToggles] = useState(getToggles());
  const [webhookToggles, setWebhookToggles] = useState<NotifWebhookToggles>({
    live: false, recordEnd: false, merge: false, hub: false, error: false,
  });
  const [savingNotif, setSavingNotif] = useState(false);
  const [webhook, setWebhook] = useState("");
  /** 后端是否已保存全局 webhook(原文不回显,只看这个标记)。 */
  const [hasWebhook, setHasWebhook] = useState(false);
  const [savingHook, setSavingHook] = useState(false);
  const [testingHook, setTestingHook] = useState(false);
  const [mesioPath, setMesioPath] = useState("");
  const [mesioDefault, setMesioDefault] = useState("");
  const [savingMesio, setSavingMesio] = useState(false);
  /** 抖音 API 模式(取流 + 弹幕 liveId 用哪个端点)。 */
  const [apiMode, setApiMode] = useState("");
  const [apiModeDefault, setApiModeDefault] = useState("balance");
  const [apiModeOptions, setApiModeOptions] = useState<string[]>([]);
  const [savingApiMode, setSavingApiMode] = useState(false);
  const [timezone, setTimezone] = useState("");
  // T15:资源闸门。resSource 决定「保存写去哪」;inline 时禁用保存并说明原因,
  // 而不是让用户点保存后拿到一个「成功」但重启即丢的配置(那是假成功)。
  const [resources, setResources] = useState<HubResources | null>(null);
  const [resSource, setResSource] = useState<string>("");
  const [savingRes, setSavingRes] = useState(false);
  const [resError, setResError] = useState("");
  const [tzDefault, setTzDefault] = useState("");
  const [tzEffective, setTzEffective] = useState("");
  const [savingTz, setSavingTz] = useState(false);
  const [version, setVersion] = useState("");
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [confirmTz, setConfirmTz] = useState<{ affected: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    setToggles(getToggles());
    void api.getCookies().then((r) => setCookieStatuses(r.platforms)).catch(() => {});
    void api.getBiliupStatus().then(setBiliupAuth).catch(() => setBiliupAuth(null));
    void api.getNotifSettings().then((r) => setWebhookToggles(r)).catch(() => {});
    void api.getWebhook().then((r) => { setHasWebhook(r.hasWebhook); setWebhook(""); }).catch(() => {});
    void api.getMesioPath().then((r) => { setMesioPath(r.mesioPath); setMesioDefault(r.default); }).catch(() => {});
    void api.getDouyinApiMode().then((r) => { setApiMode(r.mode); setApiModeDefault(r.default); setApiModeOptions(r.options); }).catch(() => {});
    void api
      .getTimezone()
      .then((r) => {
        setTimezone(r.timezone);
        setTzDefault(r.default);
        setTzEffective(r.effective);
        setServerTimezone(r.effective || r.default);
      })
      .catch(() => {});
    void api.getVersion().then((r) => setVersion(r.version)).catch(() => {});
    // T15:slave/未启用 hub → 400 是正常态(该页只在 master 有意义),静默忽略即可,
    // 但要把上次的值清掉,否则切换节点后会显示上一个 master 的并行度(假信息)。
    setResources(null);
    setResSource("");
    void api
      .getHubResources()
      .then((r) => { setResources(r.resources); setResSource(r.source); })
      .catch(() => {});
  }, [open]);

  /** 保存资源闸门。后端拒绝时把原因原样显示(非法值/无法持久化),不假装成功。 */
  const saveResources = async (): Promise<void> => {
    if (!resources) return;
    setSavingRes(true);
    setResError("");
    try {
      const r = await api.putHubResources(resources);
      setResources(r.resources);
      toast(t("settings.resourcesSaved"), "success");
    } catch (e) {
      setResError(errMessage(e));
      toast(errMessage(e), "error");
    } finally {
      setSavingRes(false);
    }
  };

  const flip = (key: NotifKey, on: boolean): void => {
    setToggles((s) => ({ ...s, [key]: on }));
  };

  const flipWebhook = (key: NotifKey, on: boolean): void => {
    setWebhookToggles((s) => ({ ...s, [key]: on }));
  };

  const webhookConfigured = hasWebhook;

  const saveNotif = async (): Promise<void> => {
    setSavingNotif(true);
    try {
      const r = await api.setNotifSettings(webhookToggles);
      setWebhookToggles(r);
      for (const key of NOTIF_KEYS) setToggle(key, toggles[key]);
      toast(t("settings.notifSaved"), "success");
    } catch (e) {
      toast(t("settings.notifFailed", { msg: errMessage(e) }), "error");
    } finally {
      setSavingNotif(false);
    }
  };

  const saveWebhook = async (): Promise<void> => {
    const v = webhook.trim();
    if (!v) { toast(t("settings.webhookKeepHint"), "info"); return; } // 留空 = 保持原值(不回显,避免误清)
    setSavingHook(true);
    try {
      const r = await api.setWebhook(v);
      setHasWebhook(r.hasWebhook);
      setWebhook("");
      toast(t("settings.webhookSaved"), "success");
    } catch (e) {
      toast(t("settings.webhookFailed", { msg: errMessage(e) }), "error");
    } finally {
      setSavingHook(false);
    }
  };

  const clearWebhook = async (): Promise<void> => {
    setSavingHook(true);
    try {
      const r = await api.setWebhook("");
      setHasWebhook(r.hasWebhook);
      setWebhook("");
      toast(t("settings.webhookCleared"), "info");
    } catch (e) {
      toast(t("settings.webhookFailed", { msg: errMessage(e) }), "error");
    } finally {
      setSavingHook(false);
    }
  };

  const testWebhook = async (): Promise<void> => {
    setTestingHook(true);
    try {
      const time = new Date().toLocaleString(lang === "zh" ? "zh-CN" : "en-US");
      await api.testWebhook(t("settings.webhookTestMessage", { time }));
      toast(t("settings.webhookTestSent"), "success");
    } catch (e) {
      // 后端 400 = 还没保存全局 webhook;其余=发送失败。
      const msg = errMessage(e);
      const noUrl = msg.includes("尚未") || msg.toLowerCase().includes("save");
      toast(noUrl ? t("settings.webhookTestNoUrl") : t("settings.webhookTestFailed", { msg }), "error");
    } finally {
      setTestingHook(false);
    }
  };

  const saveMesio = async (): Promise<void> => {
    setSavingMesio(true);
    try {
      const r = await api.setMesioPath(mesioPath.trim());
      setMesioPath(r.mesioPath);
      setMesioDefault(r.default);
      toast(t("settings.mesioSaved"), "success");
    } catch (e) {
      toast(t("settings.mesioFailed", { msg: errMessage(e) }), "error");
    } finally {
      setSavingMesio(false);
    }
  };

  const saveApiMode = async (mode: string): Promise<void> => {
    setApiMode(mode); // 乐观更新(下拉立即反映选择)
    setSavingApiMode(true);
    try {
      const r = await api.setDouyinApiMode(mode);
      setApiMode(r.mode);
      setApiModeDefault(r.default);
      setApiModeOptions(r.options);
      toast(t("settings.apiModeSaved"), "success");
    } catch (e) {
      toast(t("settings.apiModeFailed", { msg: errMessage(e) }), "error");
    } finally {
      setSavingApiMode(false);
    }
  };

  /** 实际调用 /api/timezone 落盘 + 同步全局 atom(不含确认逻辑,confirmTz 确认后或无需确认时调用)。 */
  const doSaveTimezone = async (): Promise<void> => {
    setSavingTz(true);
    try {
      const r = await api.setTimezone(timezone.trim());
      setTimezone(r.timezone);
      setTzDefault(r.default);
      setTzEffective(r.effective);
      // 全局 atom 也要同步,否则 TaskList/TaskDetail/CreateEditTaskDialog 的时区显示要等下次刷新页面才会变。
      setServerTimezone(r.effective || r.default);
      toast(t("settings.tzSaved"), "success");
    } catch (e) {
      const msg = errMessage(e);
      toast(msg.includes("不是合法") || msg.toLowerCase().includes("valid") ? t("settings.tzInvalid") : t("settings.tzFailed", { msg }), "error");
    } finally {
      setSavingTz(false);
    }
  };

  /**
   * 保存前先判断:改的目标时区和当前生效时区不同吗?**任务的 scheduleStart/scheduleEnd 是纯
   * "HH:MM" 字符串,不带时区,daemon 用当前 settings.timezone 解释它**——改时区不会改这两个字段
   * 的文本,但会整体平移所有任务真实触发的那一刻(如 Shanghai→LA 平移 15 小时),这几乎肯定不是
   * 用户想要的(主播真实开播时间没变,只是想修正时区设置本身)。有任务设了排期窗口时先警告 + 二次
   * 确认,避免改完时区后所有任务在错误的真实时刻悄悄启停。
   */
  const saveTimezone = async (): Promise<void> => {
    const target = timezone.trim() || tzDefault;
    if (target && target !== tzEffective) {
      try {
        const tasks = await api.listTasks();
        const affected = tasks.filter((tk) => tk.scheduleStart && tk.scheduleEnd).length;
        if (affected > 0) {
          setConfirmTz({ affected });
          return;
        }
      } catch {
        /* 拉任务列表失败不阻塞保存,静默跳过确认 */
      }
    }
    await doSaveTimezone();
  };

  const doClearCookie = async (platform: string): Promise<void> => {
    setConfirmClear(null);
    try {
      await api.clearCookie(platform);
      toast(t("cookie.cleared"), "info");
      const status = await api.getCookies().catch(() => null);
      if (status) setCookieStatuses(status.platforms);
      await refreshCookie();
    } catch (e) {
      toast(t("cookie.clearFailed", { msg: errMessage(e) }), "error");
    }
  };

  const cookieSummary = (platform: string): { text: string; color: string; set: boolean } => {
    const cookie = cookieStatuses.find((c) => c.platform === platform)
      ?? (platform === "douyin" ? douyinCookie : null);
    if (!cookie) return { text: t("cookie.checking"), color: "var(--warning)", set: false };
    if (cookie.set && cookie.hasSession) {
      let text = t("cookie.loggedIn");
      let color = "var(--success)";
      if (cookie.expiresAt) {
        const days = Math.floor((cookie.expiresAt - Date.now()) / 86400000);
        if (days < 0) { text = t("cookie.expired"); color = "var(--error)"; }
        else if (days <= 3) { text = t("cookie.expiresIn", { days }); }
        else { text = t("cookie.loggedInDays", { days }); }
      }
      return { text, color, set: true };
    }
    if (cookie.set) return { text: t("cookie.noSession"), color: "var(--warning)", set: true };
    return { text: t("cookie.notSet"), color: "var(--warning)", set: false };
  };

  const douyinStatus = cookieSummary("douyin");
  const bilibiliStatus = cookieSummary("bilibili");
  const kuaishouStatus = cookieSummary("kuaishou");

  const accountRows = [
    { id: "douyin", title: t("settings.douyinSection"), hint: t("settings.douyinHint"), status: douyinStatus },
    { id: "bilibili", title: t("settings.biliSection"), hint: t("settings.biliHint"), status: bilibiliStatus },
    { id: "kuaishou", title: t("settings.kuaishouSection"), hint: t("settings.kuaishouHint"), status: kuaishouStatus },
  ];

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "engine", label: t("settings.tabEngine") },
    { id: "account", label: t("settings.tabAccount") },
    { id: "notif", label: t("settings.tabNotif") },
    { id: "resources", label: t("settings.tabResources") },
    { id: "about", label: t("settings.tabAbout") },
  ];

  return (
    <Dialog open={open} onClose={onClose} widthClass="max-w-xl" title={t("settings.title")}>
      {/* tab 头:横向可滚(tab 多时只滚这一行,不撑宽对话框/整页;禁竖向溢出) */}
      <div className="flex gap-1 mb-5 border-b border-hairline overflow-x-auto overflow-y-hidden">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
              tab === tb.id ? "border-transparent text-ink font-medium" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "account" && (
        <div className="settings-tab-body">
          <div className="space-y-3">
            {accountRows.map((row) => (
              <div key={row.id} className="border border-hairline rounded-lg p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="dot" style={{ background: row.status.color }} />
                      <h4 className="text-sm font-medium text-ink">{row.title}</h4>
                    </div>
                    <p className="mt-1 text-xs text-muted-soft">{row.hint}</p>
                    <p className="mt-2 text-xs text-body">{row.status.text}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 shrink-0">
                    <Button small onClick={() => onOpenQr(row.id)}>{t("nav.login")}</Button>
                    <Button small variant="secondary" onClick={() => onOpenPaste(row.id)}>
                      <ClipboardPaste className="h-3.5 w-3.5" />
                      {t("nav.paste")}
                    </Button>
                    <Button small variant="secondary" style={{ color: "var(--error-fg)" }} onClick={() => setConfirmClear(row.id)}>
                      {t("nav.clear")}
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            <div className="border border-hairline rounded-lg p-4">
              <div className="flex items-center gap-2">
                <span
                  className="dot"
                  style={{ background: biliupAuth?.hasSession ? "var(--success)" : "var(--warning)" }}
                />
                <h4 className="text-sm font-medium text-ink">{t("settings.biliupSection")}</h4>
              </div>
              <p className="mt-2 text-xs text-body">
                {!biliupAuth
                  ? t("cookie.checking")
                  : biliupAuth.hasSession
                    ? t("cookie.loggedIn")
                    : biliupAuth.set
                      ? t("cookie.noSession")
                      : t("cookie.notSet")}
              </p>
              <p className="mt-1 text-xs text-muted-soft">{t("settings.biliupHint")}</p>
            </div>
          </div>
        </div>
      )}

      {tab === "engine" && (
        <div className="settings-tab-body">
          <h4 className="form-section">{t("settings.languageSection")}</h4>
          <label className="field-label" htmlFor="settings-language">
            {t("settings.languageLabel")}
          </label>
          <select
            id="settings-language"
            className="input text-xs"
            value={lang}
            onChange={(e) => setLang(e.target.value === "en" ? "en" : "zh")}
          >
            <option value="zh">{t("settings.languageZh")}</option>
            <option value="en">{t("settings.languageEn")}</option>
          </select>
          <p className="mt-1 text-xs text-muted-soft">{t("settings.languageHint")}</p>

          <h4 className="form-section mt-6">{t("settings.mesioSection")}</h4>
          <label className="field-label">{t("settings.mesioLabel")}</label>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder={mesioDefault || "bin/mesio"}
              value={mesioPath}
              onChange={(e) => setMesioPath(e.target.value)}
            />
            <Button small onClick={() => void saveMesio()} disabled={savingMesio} loading={savingMesio}>
              {t("common.save")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-soft">
            {t("settings.mesioHint", { path: mesioDefault || "bin/mesio" })}
          </p>

          <h4 className="form-section mt-6">{t("settings.apiModeSection")}</h4>
          <label className="field-label" htmlFor="settings-douyin-api-mode">
            {t("settings.apiModeLabel")}
          </label>
          <select
            id="settings-douyin-api-mode"
            className="input text-xs font-mono"
            value={apiMode || apiModeDefault}
            disabled={savingApiMode}
            onChange={(e) => void saveApiMode(e.target.value)}
          >
            {(apiModeOptions.length > 0 ? apiModeOptions : [apiModeDefault]).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-soft">{t("settings.apiModeHint")}</p>
          <p className="mt-1 text-xs text-muted-soft">{t("settings.apiModeDetail")}</p>

          <h4 className="form-section mt-6">{t("settings.tzSection")}</h4>
          <label className="field-label">{t("settings.tzLabel")}</label>
          <div className="flex gap-2">
            <select
              className="input flex-1 text-xs"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              <option value="">{tzDefault ? `${t("common.optional")} (${tzDefault})` : t("common.optional")}</option>
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
            <Button small onClick={() => void saveTimezone()} disabled={savingTz} loading={savingTz}>
              {t("common.save")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-soft">
            {t("settings.tzHint", { default: tzDefault || "Asia/Shanghai", effective: tzEffective || "…" })}
          </p>
        </div>
      )}

      {tab === "resources" && (
        <div className="settings-tab-body space-y-4">
          <h4 className="form-section">{t("settings.resourcesSection")}</h4>
          <p className="text-xs text-muted">{t("settings.resourcesHint")}</p>
          {!resources ? (
            <p className="text-sm text-muted">{t("settings.resourcesUnavailable")}</p>
          ) : (
            <>
              {/* inline 来源 = --hub-config 传的是 JSON 串,没有文件可写。
                  明确禁用保存并说明原因,而不是点保存拿到「成功」但重启即丢。 */}
              {resSource === "inline" && (
                <p className="text-xs text-error-fg">{t("settings.resourcesInline")}</p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {RESOURCE_FIELDS.map((f) => (
                  <label key={f.key} className="block">
                    <span className="field-label">{t(f.label)}</span>
                    <input
                      className="input"
                      type="number"
                      min={f.min}
                      value={String(resources[f.key] ?? "")}
                      onChange={(e) => {
                        // 计算属性打出的对象需要重新标注类型,否则 TS 推成
                        // { [x: string]: string|number|symbol } —— 直接构造一个新对象。
                        const v = Number(e.target.value);
                        setResources({ ...resources, [f.key]: v } as HubResources);
                      }}
                    />
                    <span className="text-xs text-muted mt-1 block">{t(f.hint)}</span>
                  </label>
                ))}
              </div>
              {resError ? <p className="text-xs text-error-fg">{resError}</p> : null}
              <div className="flex items-center gap-3">
                <Button type="button" disabled={savingRes || resSource === "inline"} onClick={() => void saveResources()}>
                  {savingRes ? t("settings.saving") : t("settings.resourcesSave")}
                </Button>
                <span className="text-xs text-muted">{t("settings.resourcesEffectiveHint")}</span>
              </div>
            </>
          )}
        </div>
      )}

      {tab === "about" && (
        <div className="settings-tab-body">
          <h4 className="form-section">{t("settings.aboutSection")}</h4>
          <div className="switch-row switch-row-sm">
            <span className="text-sm text-body">{t("settings.aboutVersion")}</span>
            <span className="font-mono text-xs text-ink">{version || "…"}</span>
          </div>
        </div>
      )}

      {tab === "notif" && (
        <div className="settings-tab-body">
          <section className="mb-6">
          <h4 className="form-section">{t("settings.webhookSection")}</h4>
          <label className="field-label">{t("settings.webhookLabel")}</label>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder={hasWebhook ? t("settings.webhookPlaceholderSet") : t("settings.webhookPlaceholder")}
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
            />
            <Button small onClick={() => void saveWebhook()} disabled={savingHook} loading={savingHook}>
              {t("common.save")}
            </Button>
            {hasWebhook && (
              <Button small variant="secondary" onClick={() => void clearWebhook()} disabled={savingHook}>
                {t("settings.webhookClear")}
              </Button>
            )}
            <Button
              small
              variant="secondary"
              onClick={() => void testWebhook()}
              disabled={testingHook || !hasWebhook}
              loading={testingHook}
            >
              {t("settings.webhookTest")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-soft">
            {hasWebhook ? t("settings.webhookHintSet") : t("settings.webhookHint")}
          </p>
        
          </section>

          <p className="text-xs text-muted-soft mb-2">{t("notif.desc")}</p>
          <div className="rounded-md border border-hairline bg-raised overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-0 px-4 py-2 border-b border-hairline text-xs text-muted-soft">
              <span>{t("notif.typeLabel")}</span>
              <span className="w-16 text-center">{t("notif.inAppLabel")}</span>
              <span className="w-16 text-center">{t("notif.webhookLabel")}</span>
            </div>
            {NOTIF_KEYS.map((key) => (
              <div
                key={key}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 px-4 py-3 border-b border-hairline last:border-b-0"
              >
                <span className="text-sm font-medium text-ink">{t(`notif.${key}`)}</span>
                <div className="w-16 flex justify-center">
                  <Switch checked={toggles[key]} onCheckedChange={(v) => flip(key, v)} name={`notif-inapp-${key}`} />
                </div>
                <div className="w-16 flex justify-center">
                  <Switch
                    checked={webhookConfigured && webhookToggles[key]}
                    disabled={!webhookConfigured}
                    onCheckedChange={(v) => flipWebhook(key, v)}
                    name={`notif-webhook-${key}`}
                  />
                </div>
              </div>
            ))}
          </div>
          {!webhookConfigured && (
            <p className="mt-2 text-xs text-muted-soft">{t("notif.webhookLockedHint")}</p>
          )}
          <div className="mt-3 flex justify-end">
            <Button small onClick={() => void saveNotif()} disabled={savingNotif} loading={savingNotif}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear !== null}
        title={t("cookie.clearConfirm")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => {
          if (confirmClear) void doClearCookie(confirmClear);
        }}
        onCancel={() => setConfirmClear(null)}
      />

      <ConfirmDialog
        open={confirmTz !== null}
        title={t("settings.tzChangeConfirmTitle")}
        message={confirmTz ? t("settings.tzChangeConfirmMessage", { count: confirmTz.affected }) : undefined}
        confirmLabel={t("settings.tzChangeConfirmButton")}
        destructive
        onConfirm={() => {
          setConfirmTz(null);
          void doSaveTimezone();
        }}
        onCancel={() => setConfirmTz(null)}
      />
    </Dialog>
  );
}
