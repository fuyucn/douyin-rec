/**
 * JobLogCleanup — manual cleanup of hub job logs older than N days (issue #414).
 * Retention is unchanged (logs are kept forever); this only deletes on an explicit click, and only
 * after a preview for the same number of days, so the confirm text matches what gets removed.
 */
import { useState, type ReactNode } from "react";
import { api } from "../api/client";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { useT } from "../lib/i18n";
import { errMessage, useToast } from "../lib/hooks";

function humanSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function JobLogCleanup(): ReactNode {
  const t = useT();
  const toast = useToast();
  const [days, setDays] = useState("7");
  const [preview, setPreview] = useState<{ days: number; count: number; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 3650;
  // A preview only counts for the exact day count it was made with.
  const previewOk = preview !== null && valid && preview.days === n;

  const runPreview = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.previewJobLogs(n);
      setPreview({ days: n, count: r.count, bytes: r.bytes });
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async (): Promise<void> => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      const r = await api.cleanupJobLogs(n);
      setPreview(null);
      toast(t("hub.page.logsDone", { deleted: r.deleted, size: humanSize(r.bytes) }), "info");
      if (r.failed.length > 0) {
        toast(t("hub.page.logsFailed", { count: r.failed.length, names: r.failed.map((f) => f.file).join(", ") }), "error");
      }
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4 mt-6">
      <div className="text-sm font-medium text-ink">{t("hub.page.logsTitle")}</div>
      <p className="text-xs text-muted-soft mt-1">{t("hub.page.logsHint")}</p>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <label className="text-xs text-muted" htmlFor="job-log-days">{t("hub.page.logsDays")}</label>
        <input
          id="job-log-days"
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => { setDays(e.target.value); setPreview(null); }}
          className="w-24 rounded border border-hairline bg-raised px-2 py-1 text-sm"
        />
        <Button small variant="secondary" disabled={busy || !valid} onClick={() => void runPreview()}>
          {t("hub.page.logsPreview")}
        </Button>
        <Button small variant="secondary" disabled={busy || !previewOk || (preview?.count ?? 0) === 0} onClick={() => setConfirmOpen(true)}>
          {t("hub.page.logsCleanup")}
        </Button>
      </div>
      {previewOk && preview && (
        <div className="text-xs text-muted mt-2">{t("hub.page.logsPreviewResult", { count: preview.count, size: humanSize(preview.bytes) })}</div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title={t("hub.page.logsConfirmTitle")}
        message={preview ? t("hub.page.logsConfirmMessage", { count: preview.count, days: n, size: humanSize(preview.bytes) }) : ""}
        destructive
        onConfirm={() => void runCleanup()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
