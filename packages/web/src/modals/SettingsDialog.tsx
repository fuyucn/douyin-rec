import { useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { errMessage, useRefreshCookie, useToast } from "../lib/hooks";
import { useT, useLang } from "../lib/i18n";
import { getToggles, setToggle, NOTIF_KEYS, type NotifKey } from "../lib/notifications";

type Tab = "account" | "webhook" | "engine" | "notif" | "about";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 打开扫码登录 / 手动粘贴(对话框由 TopNav 渲染,这里只触发)。 */
  onOpenQr: () => void;
  onOpenPaste: () => void;
}

/** 设置:分类 tabs —— 账号 Cookie(扫码/粘贴/清除)/ 全局 Webhook / 站内提醒开关。 */
export function SettingsDialog({ open, onClose, onOpenQr, onOpenPaste }: Props): ReactNode {
  const t = useT();
  const [lang] = useLang();
  const toast = useToast();
  const refreshCookie = useRefreshCookie();
  const cookie = useAtomValue(cookieStatusAtom);
  const [tab, setTab] = useState<Tab>("account");
  const [toggles, setToggles] = useState(getToggles());
  const [webhook, setWebhook] = useState("");
  const [savingHook, setSavingHook] = useState(false);
  const [testingHook, setTestingHook] = useState(false);
  const [mesioPath, setMesioPath] = useState("");
  const [mesioDefault, setMesioDefault] = useState("");
  const [savingMesio, setSavingMesio] = useState(false);
  const [version, setVersion] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToggles(getToggles());
    void api.getWebhook().then((r) => setWebhook(r.webhook)).catch(() => {});
    void api.getMesioPath().then((r) => { setMesioPath(r.mesioPath); setMesioDefault(r.default); }).catch(() => {});
    void api.getVersion().then((r) => setVersion(r.version)).catch(() => {});
  }, [open]);

  const flip = (key: NotifKey, on: boolean): void => {
    setToggle(key, on);
    setToggles((s) => ({ ...s, [key]: on }));
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

  const doClearCookie = async (): Promise<void> => {
    setConfirmClear(false);
    try {
      await api.clearCookie();
      toast(t("cookie.cleared"), "info");
      await refreshCookie();
    } catch (e) {
      toast(t("cookie.clearFailed", { msg: errMessage(e) }), "error");
    }
  };

  // 账号 cookie 状态行(复用顶栏 pill 逻辑)。
  let statusText = t("cookie.checking");
  let statusColor = "var(--warning)";
  if (cookie) {
    if (cookie.set && cookie.hasSession) {
      statusText = t("cookie.loggedIn");
      statusColor = "var(--success)";
      if (cookie.expiresAt) {
        const days = Math.floor((cookie.expiresAt - Date.now()) / 86400000);
        if (days < 0) { statusText = t("cookie.expired"); statusColor = "var(--error)"; }
        else if (days <= 3) { statusText = t("cookie.expiresIn", { days }); }
        else { statusText = t("cookie.loggedInDays", { days }); }
      }
    } else if (cookie.set) { statusText = t("cookie.noSession"); }
    else { statusText = t("cookie.notSet"); }
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "account", label: t("settings.tabAccount") },
    { id: "webhook", label: t("settings.tabWebhook") },
    { id: "engine", label: t("settings.tabEngine") },
    { id: "notif", label: t("settings.tabNotif") },
    { id: "about", label: t("settings.tabAbout") },
  ];

  return (
    <Dialog open={open} onClose={onClose} widthClass="max-w-md" title={t("settings.title")}>
      {/* tab 头:横向可滚(tab 多时只滚这一行,不撑宽对话框/整页;禁竖向溢出) */}
      <div className="flex gap-1 mb-5 border-b border-hairline overflow-x-auto overflow-y-hidden">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
              tab === tb.id ? "border-ink text-ink font-medium" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "account" && (
        <div>
          <h4 className="text-sm font-semibold text-ink mb-1">{t("settings.accountSection")}</h4>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className="dot" style={{ background: statusColor }} />
            <span className="text-body">{statusText}</span>
          </div>
          <div className="flex gap-2">
            <Button small onClick={onOpenQr}>{t("nav.login")}</Button>
            <Button small variant="secondary" onClick={onOpenPaste}>{t("nav.paste")}</Button>
            <Button small variant="secondary" style={{ color: "var(--error)" }} onClick={() => setConfirmClear(true)}>
              {t("nav.clear")}
            </Button>
          </div>
          <p className="mt-3 text-[12px] text-muted-soft">{t("settings.accountHint")}</p>
        </div>
      )}

      {tab === "webhook" && (
        <div>
          <h4 className="text-sm font-semibold text-ink mb-2">{t("settings.webhookSection")}</h4>
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
          <p className="mt-1 text-[12px] text-muted-soft">{t("settings.webhookHint")}</p>
        </div>
      )}

      {tab === "engine" && (
        <div>
          <h4 className="text-sm font-semibold text-ink mb-2">{t("settings.mesioSection")}</h4>
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
          <p className="mt-1 text-[12px] text-muted-soft">
            {t("settings.mesioHint", { path: mesioDefault || "bin/mesio" })}
          </p>
        </div>
      )}

      {tab === "about" && (
        <div>
          <h4 className="text-sm font-semibold text-ink mb-2">{t("settings.aboutSection")}</h4>
          <div className="flex items-center justify-between rounded-lg border border-hairline px-4 py-2.5">
            <span className="text-sm text-body">{t("settings.aboutVersion")}</span>
            <span className="font-mono text-xs text-ink">{version || "…"}</span>
          </div>
          <p className="mt-2 text-[12px] text-muted-soft">{t("settings.aboutHint")}</p>
        </div>
      )}

      {tab === "notif" && (
        <div>
          <p className="text-xs text-muted-soft mb-2">{t("notif.desc")}</p>
          <div className="space-y-2">
            {NOTIF_KEYS.map((key) => (
              <label
                key={key}
                className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-2.5 cursor-pointer"
              >
                <span className="text-sm font-medium text-ink">{t(`notif.${key}`)}</span>
                <Switch checked={toggles[key]} onCheckedChange={(v) => flip(key, v)} name={`notif-${key}`} />
              </label>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title={t("cookie.clearConfirm")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => void doClearCookie()}
        onCancel={() => setConfirmClear(false)}
      />
    </Dialog>
  );
}
