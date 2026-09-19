import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ClipboardPaste } from "lucide-react";
import { api } from "../api/client";
import { cookieStatusAtom, serverTimezoneAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { errMessage, useRefreshCookie, useToast } from "../lib/hooks";
import { useT, useLang } from "../lib/i18n";
import { getToggles, setToggle, NOTIF_KEYS, type NotifKey } from "../lib/notifications";
import type { BiliupAuthStatus, CookieStatus, NotifWebhookToggles } from "@drec/contracts";

type Tab = "account" | "webhook" | "engine" | "notif" | "about";

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
  const [savingHook, setSavingHook] = useState(false);
  const [testingHook, setTestingHook] = useState(false);
  const [mesioPath, setMesioPath] = useState("");
  const [mesioDefault, setMesioDefault] = useState("");
  const [savingMesio, setSavingMesio] = useState(false);
  const [timezone, setTimezone] = useState("");
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
    void api.getWebhook().then((r) => setWebhook(r.webhook)).catch(() => {});
    void api.getMesioPath().then((r) => { setMesioPath(r.mesioPath); setMesioDefault(r.default); }).catch(() => {});
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
  }, [open]);

  const flip = (key: NotifKey, on: boolean): void => {
    setToggles((s) => ({ ...s, [key]: on }));
  };

  const flipWebhook = (key: NotifKey, on: boolean): void => {
    setWebhookToggles((s) => ({ ...s, [key]: on }));
  };

  const webhookConfigured = webhook.trim().length > 0;

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
    setSavingHook(true);
    try {
      const r = await api.setWebhook(webhook.trim());
      setWebhook(r.webhook);
      toast(t("settings.webhookSaved"), "success");
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

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "engine", label: t("settings.tabEngine") },
    { id: "account", label: t("settings.tabAccount") },
    { id: "webhook", label: t("settings.tabWebhook") },
    { id: "notif", label: t("settings.tabNotif") },
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
        <div>
          <h4 className="form-section">{t("settings.douyinSection")}</h4>
          <div className="status-strip mb-3">
            <span className="dot" style={{ background: douyinStatus.color }} />
            <span className="text-body">{douyinStatus.text}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={() => onOpenQr("douyin")}>{t("nav.login")}</Button>
            <Button small variant="secondary" onClick={() => onOpenPaste("douyin")}>
              <ClipboardPaste className="h-3.5 w-3.5" />
              {t("settings.douyinPaste")}
            </Button>
            <Button small variant="secondary" style={{ color: "var(--error-fg)" }} onClick={() => setConfirmClear("douyin")}>
              {t("nav.clear")}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-soft">{t("settings.douyinHint")}</p>

          <h4 className="form-section mt-6">{t("settings.biliSection")}</h4>
          <div className="status-strip mb-3">
            <span className="dot" style={{ background: bilibiliStatus.color }} />
            <span className="text-body">{bilibiliStatus.text}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button small onClick={() => onOpenQr("bilibili")}>{t("nav.login")}</Button>
            <Button small onClick={() => onOpenPaste("bilibili")}>
              <ClipboardPaste className="h-3.5 w-3.5" />
              {t("settings.biliPaste")}
            </Button>
            <Button
              small
              variant="secondary"
              style={{ color: "var(--error-fg)" }}
              onClick={() => setConfirmClear("bilibili")}
            >
              {t("nav.clear")}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-soft">{t("settings.biliHint")}</p>

          <h4 className="form-section mt-6">{t("settings.biliupSection")}</h4>
          <div className="status-strip mb-3">
            <span
              className="dot"
              style={{ background: biliupAuth?.hasSession ? "var(--success)" : "var(--warning)" }}
            />
            <span className="text-body">
              {!biliupAuth
                ? t("cookie.checking")
                : biliupAuth.hasSession
                  ? t("cookie.loggedIn")
                  : biliupAuth.set
                    ? t("cookie.noSession")
                    : t("cookie.notSet")}
            </span>
          </div>
          <p className="text-xs text-muted-soft">{t("settings.biliupHint")}</p>
        </div>
      )}

      {tab === "webhook" && (
        <div>
          <h4 className="form-section">{t("settings.webhookSection")}</h4>
          <label className="field-label">{t("settings.webhookLabel")}</label>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              placeholder={t("settings.webhookPlaceholder")}
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
            />
            <Button small onClick={() => void saveWebhook()} disabled={savingHook} loading={savingHook}>
              {t("common.save")}
            </Button>
            <Button
              small
              variant="secondary"
              onClick={() => void testWebhook()}
              disabled={testingHook || !webhook.trim()}
              loading={testingHook}
            >
              {t("settings.webhookTest")}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-soft">{t("settings.webhookHint")}</p>
        </div>
      )}

      {tab === "engine" && (
        <div>
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

      {tab === "about" && (
        <div>
          <h4 className="form-section">{t("settings.aboutSection")}</h4>
          <div className="switch-row switch-row-sm">
            <span className="text-sm text-body">{t("settings.aboutVersion")}</span>
            <span className="font-mono text-xs text-ink">{version || "…"}</span>
          </div>
        </div>
      )}

      {tab === "notif" && (
        <div>
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
