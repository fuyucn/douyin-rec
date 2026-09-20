import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { ExternalLink } from "lucide-react";
import { api } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { errMessage, useRefreshCookie, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 当前 cookie 状态行（含 sid_guard 解析出的过期日期）。 */
function cookieStatusLine(c: { set: boolean; hasSession: boolean; expiresAt: number | null } | null, t: T): string {
  if (!c || !c.set) return t("paste.stUnset");
  const base = c.hasSession ? t("paste.stLoggedIn") : t("paste.stSetNoSession");
  if (!c.expiresAt) return base;
  const d = new Date(c.expiresAt);
  const days = Math.floor((c.expiresAt - Date.now()) / 86400000);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return days < 0 ? t("paste.expiredOn", { base, date }) : t("paste.validUntil", { base, date, days });
}

interface Props {
  open: boolean;
  onClose: () => void;
  platform?: string;
}

/** Manual cookie paste modal (set one platform's cookie). */
export function CookieDialog({ open, onClose, platform = "douyin" }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const refreshCookie = useRefreshCookie();
  const isBilibili = platform === "bilibili";
  const isKuaishou = platform === "kuaishou";
  const atomCookie = useAtomValue(cookieStatusAtom);
  const [cookie, setCookie] = useState<typeof atomCookie>(atomCookie);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      void api.getCookie(platform).then(setCookie).catch(() => setCookie(null));
      const t = setTimeout(() => ref.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open, platform]);

  async function save(): Promise<void> {
    const cookie = value.trim();
    if (!cookie) {
      toast(t("paste.empty"), "warning");
      return;
    }
    if (isBilibili && !/(?:^|;\s*)SESSDATA=/.test(cookie)) {
      toast(t("paste.biliMissingSession"), "error");
      return;
    }
    setBusy(true);
    try {
      const status = await api.setCookie(cookie, platform);
      setCookie(status);
      onClose();
      toast(t("paste.saved"), "success");
      await refreshCookie();
    } catch (e) {
      toast(t("paste.saveFailed", { msg: errMessage(e) }), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isBilibili ? t("paste.biliTitle") : isKuaishou ? t("paste.ksTitle") : t("paste.title")}
      description={isBilibili ? t("paste.biliDesc") : isKuaishou ? t("paste.ksDesc") : t("paste.desc")}
      widthClass={isBilibili || isKuaishou ? "max-w-2xl" : "max-w-lg"}
    >
      <div className="status-strip mb-3">
        {cookieStatusLine(cookie, t)}
      </div>
      {isBilibili && (
        <div className="mb-4 border-y border-hairline py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">{t("paste.biliGuideTitle")}</p>
            <a
              href="https://www.bilibili.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink"
            >
              {t("paste.biliOpen")}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-muted">
            <li>{t("paste.biliStep1")}</li>
            <li>{t("paste.biliStep2")}</li>
            <li>{t("paste.biliStep3")}</li>
            <li>{t("paste.biliStep4")}</li>
            <li>{t("paste.biliStep5")}</li>
          </ol>
          <p className="mt-3 text-xs text-muted-soft">{t("paste.biliFallback")}</p>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink">
            {t("paste.biliRequired")}
          </p>
        </div>
      )}
      <textarea
        ref={ref}
        rows={4}
        aria-label={isBilibili ? t("paste.biliTitle") : t("paste.title")}
        className="textarea font-mono text-xs"
        placeholder={isBilibili
          ? "SESSDATA=...; bili_jct=...; DedeUserID=...; ..."
          : "sessionid=...; sessionid_ss=...; ttwid=...; ..."}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="flex justify-end gap-3 mt-5">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="button" disabled={busy} loading={busy} onClick={save}>
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
