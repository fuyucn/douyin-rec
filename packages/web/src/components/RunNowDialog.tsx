/**
 * RunNowDialog — shared "run now" form for a room's existing recordings.
 *
 * The dialog only collects the broadcast date, run mode and optional winner
 * node. Key construction and the API call stay with the caller so both the
 * legacy room detail and the unified room page share one implementation.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { HubJobDTO, WorkerDTO } from "../api/client";
import { runDate } from "./HubJobs";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { useT } from "../lib/i18n";
import { runNowKey } from "../lib/run-now";

const CUSTOM_DATE = "__custom__";

export function RunNowDialog({
  open,
  onClose,
  runs,
  workers,
  roomPrefix,
  roomWorkerIds,
  today,
  busy,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** Newest first, same order as the runs panel. */
  runs: HubJobDTO[];
  workers: WorkerDTO[];
  /** `{platform}:{roomSlug}` used when the user types a custom date. */
  roomPrefix: string;
  /** null/empty = every worker is eligible. */
  roomWorkerIds?: string[] | null;
  /** Today in the server timezone. */
  today: string;
  busy: boolean;
  onSubmit: (input: { key: string; winnerWorker?: string }) => void | Promise<void>;
}): ReactNode {
  const t = useT();
  const [runKey, setRunKey] = useState(CUSTOM_DATE);
  const [customDate, setCustomDate] = useState(today);
  const [winnerWorker, setWinnerWorker] = useState("");
  // Default to a new submission: reusing the same id makes a retry look like
  // nothing happened when the old run already has a BV.
  const [newSubmission, setNewSubmission] = useState(true);

  // Seed on every open, not on every render: runs refresh in the background and
  // must not overwrite what the user is editing.
  useEffect(() => {
    if (!open) return;
    setRunKey(runs[0]?.streamKey ?? CUSTOM_DATE);
    setCustomDate(runs[0] ? runDate(runs[0].streamKey).slice(0, 10) : today);
    setWinnerWorker("");
    setNewSubmission(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedKey = runKey === CUSTOM_DATE ? `${roomPrefix}:${customDate.trim()}` : runKey;
  const validDate = runKey !== CUSTOM_DATE || /^\d{4}-\d{2}-\d{2}$/.test(customDate.trim());
  const nextKey = runNowKey({
    selectedKey,
    existingKeys: runs.map((j) => j.streamKey),
    newSubmission,
  });
  const eligible = roomWorkerIds && roomWorkerIds.length > 0
    ? workers.filter((w) => roomWorkerIds.includes(w.id))
    : workers;

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={t("hub.jobs.runNowTitle")}
      description={t("hub.jobs.runNowDesc")}
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="field-label">{t("hub.jobs.runNowDate")}</label>
          <select className="input" value={runKey} onChange={(e) => setRunKey(e.target.value)}>
            {runs.map((j) => (
              <option key={j.streamKey} value={j.streamKey}>{runDate(j.streamKey)}</option>
            ))}
            <option value={CUSTOM_DATE}>{t("hub.jobs.runNowCustom")}</option>
          </select>
        </div>
        {runKey === CUSTOM_DATE && (
          <div>
            <label className="field-label">{t("hub.jobs.runNowDateHint")}</label>
            <input className="input" value={customDate} onChange={(e) => setCustomDate(e.target.value)} placeholder={today} />
            {!validDate && <p className="text-xs mt-1" style={{ color: "var(--error-fg)" }}>{t("hub.jobs.runNowDateHint")}</p>}
          </div>
        )}
        <div>
          <label className="field-label">{t("hub.jobs.runNowMode")}</label>
          <select className="input" value={newSubmission ? "new" : "resume"} onChange={(e) => setNewSubmission(e.target.value === "new")}>
            <option value="resume">{t("hub.jobs.runNowResume")}</option>
            <option value="new">{t("hub.jobs.runNowNew")}</option>
          </select>
        </div>
        {newSubmission && <p className="text-[12px] text-muted-soft">{t("hub.jobs.runNowNewHint", { key: nextKey })}</p>}
        <div>
          <label className="field-label">{t("hub.jobs.runNowWorker")}</label>
          <select className="input" value={winnerWorker} onChange={(e) => setWinnerWorker(e.target.value)}>
            <option value="">{t("hub.jobs.runNowWorkerAuto")}</option>
            {eligible.map((w) => (
              <option key={w.id} value={w.id}>{w.name || w.id}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {t("hub.common.cancel")}
          </Button>
          <Button
            type="button"
            loading={busy}
            disabled={busy || !validDate || selectedKey === ""}
            onClick={() => void onSubmit({ key: nextKey, winnerWorker: winnerWorker || undefined })}
          >
            {t("hub.jobs.runNow")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
