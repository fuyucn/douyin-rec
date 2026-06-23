import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
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
}

/** Manual cookie paste modal (set the global Douyin cookie). */
export function CookieDialog({ open, onClose }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const refreshCookie = useRefreshCookie();
  const cookie = useAtomValue(cookieStatusAtom);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      const t = setTimeout(() => ref.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  async function save(): Promise<void> {
    const cookie = value.trim();
    if (!cookie) {
      toast(t("paste.empty"), "warning");
      return;
    }
    setBusy(true);
    try {
      await api.setCookie(cookie);
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
      title={t("paste.title")}
      description={t("paste.desc")}
    >
      <div className="mb-3 text-xs text-muted bg-surface-soft border border-hairline rounded px-3 py-2">
        {cookieStatusLine(cookie, t)}
      </div>
      <textarea
        ref={ref}
        rows={4}
        className="textarea font-mono text-xs"
        placeholder="sessionid=...; sessionid_ss=...; ttwid=...; ..."
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
