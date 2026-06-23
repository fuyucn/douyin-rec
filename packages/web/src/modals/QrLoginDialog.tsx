import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { errMessage, useRefreshCookie, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** state → { i18n key, badge class, spinner }。文案渲染时经 t() 取。 */
const STATE_META: Record<string, { key: string; cls: string; spin: boolean }> = {
  pending: { key: "qr.stPending", cls: "badge-neutral", spin: true },
  scanned: { key: "qr.stScanned", cls: "badge-violet", spin: true },
  confirmed: { key: "qr.stConfirmed", cls: "badge-success", spin: false },
  expired: { key: "qr.stExpired", cls: "badge-error", spin: false },
};

/** Abducts a QR login: POST /api/login/qr → show qrPng → poll status. */
export function QrLoginDialog({ open, onClose }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const refreshCookie = useRefreshCookie();
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [state, setState] = useState<string>("pending");
  const [override, setOverride] = useState<string | null>(null);

  const sidRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    const sid = sidRef.current;
    if (!sid) return;
    try {
      const r = await api.pollLogin(sid);
      setState(r.state);
      setOverride(null);
      if (r.state === "confirmed") {
        stopPoll();
        await refreshCookie();
        toast(t("qr.success"), "success");
        closeTimerRef.current = setTimeout(onClose, 1200);
        return;
      }
      if (r.state === "expired") {
        stopPoll();
        closeTimerRef.current = setTimeout(() => void start(), 800);
        return;
      }
    } catch (e) {
      setState("expired");
      setOverride(t("qr.err", { msg: errMessage(e) }));
      stopPoll();
      return;
    }
    pollRef.current = setTimeout(() => void poll(), 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, refreshCookie, stopPoll, toast, t]);

  const start = useCallback(async (): Promise<void> => {
    stopPoll();
    setQrPng(null);
    setState("pending");
    setOverride(t("qr.launching"));
    try {
      const r = await api.startLogin();
      sidRef.current = r.sessionId;
      setQrPng(r.qrPng);
      setOverride(null);
      void poll();
    } catch (e) {
      setState("expired");
      setOverride(t("qr.fetchFailed", { msg: errMessage(e) }));
      toast(t("qr.fetchFailed", { msg: errMessage(e) }), "error");
    }
  }, [poll, stopPoll, toast, t]);

  // Start on open; clean up all timers on close/unmount.
  useEffect(() => {
    if (open) {
      void start();
    }
    return () => {
      stopPoll();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      sidRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const info = STATE_META[state] ?? { key: "", cls: "badge-neutral", spin: true };

  return (
    <Dialog open={open} onClose={onClose} widthClass="max-w-sm" center title={t("qr.title")}>
      <p className="text-sm text-muted mb-5">{t("qr.desc")}</p>
      <div className="flex justify-center mb-5">
        <div className="bg-white border border-hairline rounded-lg p-4 w-[232px] h-[232px] flex items-center justify-center">
          {qrPng ? (
            <img
              className="qr-img w-[200px] h-[200px]"
              alt={t("qr.alt")}
              src={`data:image/png;base64,${qrPng}`}
            />
          ) : (
            <span className="spinner spinner-lg" />
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 mb-5">
        {info.spin && <span className="spinner" style={{ color: "var(--muted-soft)" }} />}
        <span className={`badge ${info.cls}`}>{override ?? (info.key ? t(info.key) : state)}</span>
      </div>
      <div className="flex justify-center">
        <Button variant="secondary" onClick={onClose}>
          {t("qr.close")}
        </Button>
      </div>
    </Dialog>
  );
}
