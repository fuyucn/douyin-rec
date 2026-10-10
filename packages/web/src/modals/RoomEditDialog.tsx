/**
 * RoomEditDialog — **一个弹窗改完一个房间**(T20 第 1 步)。
 *
 * 录制半边 + 处理半边同处一屏,保存走 `PUT /api/rooms/:key` —— 后端**先写 task、再写规则,
 * 第二步失败回滚第一步**,所以不会出现「画质改了但处理没改」的半成功(这是 T9 的设计要点)。
 *
 * 与旧弹窗的关系:CreateEditTaskDialog(纯任务)与 HubRuleDialog(纯规则)**都不动**。
 * 本弹窗只服务 /rooms 页,是「并存版」的新增件 —— 出问题删掉它即可,零回归风险。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type PlatformDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, qualityLabel } from "../lib/labels";

interface Props {
  open: boolean;
  room: RoomDTO;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  // 录制半边
  name: string;
  quality: string;
  engine: string;
  segmentSec: string;
  danmu: boolean;
  useCookie: boolean;
  recEnabled: boolean;
  // 处理半边
  procEnabled: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  mergeSegments: boolean;
  nodeSideUpload: boolean;
  uploadMode: string;      // stage | upload
  uploadPrivate: boolean;
  uploadTag: string;
  uploadTid: string;
  uploadDesc: string;
  workers: string[];
}

function fromRoom(r: RoomDTO): FormState {
  const rec = r.recording;
  const p = r.processing?.pipeline ?? {};
  return {
    name: rec?.name ?? "",
    quality: rec?.quality ?? "",
    engine: rec?.engine ?? "",
    segmentSec: String(rec?.segmentSec ?? 1800),
    danmu: !!rec?.danmu,
    useCookie: rec?.useCookie ?? true,
    recEnabled: rec?.enabled ?? true,
    procEnabled: r.processing?.enabled ?? true,
    burnDanmu: p.steps?.burnDanmu === true,
    burnLivechat: p.steps?.burnLivechat === true,
    mergeSegments: p.steps?.mergeSegments !== false,
    nodeSideUpload: p.steps?.nodeSideUpload === true,
    uploadMode: p.upload?.mode === "upload" ? "upload" : "stage",
    uploadPrivate: p.upload?.private !== false,
    uploadTag: p.upload?.tag ?? "",
    uploadTid: String(p.upload?.tid ?? 21),
    uploadDesc: p.upload?.desc ?? "",
    workers: r.processing?.workers ?? [],
  };
}

export function RoomEditDialog({ open, room, onClose, onSaved }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromRoom(room));
  const [busy, setBusy] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);

  useEffect(() => { setForm(fromRoom(room)); }, [room.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 平台清单:画质/引擎候选取该平台白名单(与任务弹窗共用 pickPlatform,不写第二份匹配)。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.getPlatforms().then((r) => { if (alive) setPlatforms(r.platforms ?? []); }).catch(() => {});
    void api.listWorkers().then((ws) => { if (alive) setWorkers(ws); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);

  const plat = pickPlatform(room.room, platforms);
  const qualityOptions = plat?.qualities ?? [];
  const engineOptions = plat?.engines ?? [];
  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setForm((f) => ({ ...f, [k]: v }));

  const toggleWorker = (id: string): void =>
    setForm((f) => ({ ...f, workers: f.workers.includes(id) ? f.workers.filter((x) => x !== id) : [...f.workers, id] }));

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true);
    try {
      // 一次 PUT 写两半。recording 只在有录制任务时才发(纯规则房间不该被造出 task —— 后端也会挡住)。
      const recording = room.recording
        ? {
            name: form.name.trim() || null,
            quality: form.quality,
            engine: form.engine,
            segmentSec: Number(form.segmentSec) || 1800,
            danmu: form.danmu ? 1 : 0,
            useCookie: form.useCookie,
            enabled: form.recEnabled,
          }
        : undefined;

      await api.updateRoom(room.key, {
        ...(recording ? { recording } : {}),
        processing: {
          enabled: form.procEnabled,
          workers: form.workers,
          pipeline: {
            steps: {
              mergeSegments: form.mergeSegments,
              burnDanmu: form.burnDanmu,
              burnLivechat: form.burnLivechat,
              nodeSideUpload: form.nodeSideUpload,
            },
            upload: {
              mode: form.uploadMode === "upload" ? "upload" : "stage",
              private: form.uploadPrivate,
              tag: form.uploadTag.trim() || undefined,
              tid: Number(form.uploadTid) || 21,
              desc: form.uploadDesc.trim() || undefined,
            },
          },
        },
      });
      toast(t("rooms.saved"), "success");
      onSaved();
    } catch (e) {
      // 后端失败信息里会说明「哪一半失败、是否已回滚」—— 原样展示,不吞。
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} widthClass="max-w-2xl"
      title={t("rooms.editTitle")}
      description={t("rooms.editDesc")}>
      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* ── 录制半边 ──────────────────────────────────────────────── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("rooms.recordingSection")}</h3>
          {!room.recording ? (
            <p className="text-xs text-muted">{t("rooms.onlyRule")}</p>
          ) : (
            <>
              <label className="flex items-center gap-2 mb-3">
                <Switch checked={form.recEnabled} onCheckedChange={(v: boolean) => set("recEnabled", v)} />
                <span className="text-sm">{t("rooms.recEnabledLabel")}</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="field-label">{t("rooms.name")}</span>
                  <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
                </label>
                <label className="block">
                  <span className="field-label">{t("rooms.segmentSec")}</span>
                  <input className="input" type="number" min={60} value={form.segmentSec}
                         onChange={(e) => set("segmentSec", e.target.value)} />
                </label>
                <label className="block">
                  <span className="field-label">{t("rooms.quality")}</span>
                  <select className="input" value={form.quality} onChange={(e) => set("quality", e.target.value)}>
                    {!qualityOptions.includes(form.quality) && <option value={form.quality}>{form.quality || "-"}</option>}
                    {qualityOptions.map((q) => <option key={q} value={q}>{qualityLabel(q)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="field-label">{t("rooms.engine")}</span>
                  <select className="input" value={form.engine} onChange={(e) => set("engine", e.target.value)}>
                    {!engineOptions.includes(form.engine) && <option value={form.engine}>{form.engine || "-"}</option>}
                    {engineOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-5 mt-3">
                <label className="flex items-center gap-2">
                  <Switch checked={form.danmu} onCheckedChange={(v: boolean) => set("danmu", v)} />
                  <span className="text-sm">{t("rooms.danmu")}</span>
                </label>
                <label className="flex items-center gap-2">
                  <Switch checked={form.useCookie} onCheckedChange={(v: boolean) => set("useCookie", v)} />
                  <span className="text-sm">{t("rooms.useCookie")}</span>
                </label>
              </div>
            </>
          )}
        </div>

        {/* ── 处理半边 ──────────────────────────────────────────────── */}
        <div className="sm:col-span-2 border-t border-hairline pt-4">
          <h3 className="form-section">{t("rooms.processingSection")}</h3>
          <label className="flex items-center gap-2 mb-3">
            <Switch checked={form.procEnabled} onCheckedChange={(v: boolean) => set("procEnabled", v)} />
            <span className="text-sm">{t("rooms.procEnabledLabel")}</span>
          </label>
          <div className="flex flex-wrap gap-5 mb-3">
            <label className="flex items-center gap-2">
              <Switch checked={form.mergeSegments} onCheckedChange={(v: boolean) => set("mergeSegments", v)} />
              <span className="text-sm">{t("rooms.mergeSegments")}</span>
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={form.burnDanmu} onCheckedChange={(v: boolean) => set("burnDanmu", v)} />
              <span className="text-sm">{t("rooms.burnDanmu")}</span>
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={form.burnLivechat} onCheckedChange={(v: boolean) => set("burnLivechat", v)} />
              <span className="text-sm">{t("rooms.burnLivechat")}</span>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">{t("rooms.uploadMode")}</span>
              <select className="input" value={form.uploadMode} onChange={(e) => set("uploadMode", e.target.value)}>
                <option value="stage">{t("rooms.uploadStage")}</option>
                <option value="upload">{t("rooms.uploadUpload")}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 self-end pb-2">
              <Switch checked={form.nodeSideUpload} onCheckedChange={(v: boolean) => set("nodeSideUpload", v)}
                      disabled={form.burnDanmu || form.burnLivechat} />
              <span className="text-sm">
                {t("rooms.nodeSideUpload")}
                {/* 烧录与节点侧上传在代码里是互斥的(弱节点烧不动)→ 开了烧录就禁用并说明 */}
                {(form.burnDanmu || form.burnLivechat) && <span className="text-xs text-muted"> · {t("rooms.nodeSideUploadDisabled")}</span>}
              </span>
            </label>
            <label className="block">
              <span className="field-label">{t("rooms.uploadTag")}</span>
              <input className="input" value={form.uploadTag} onChange={(e) => set("uploadTag", e.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">{t("rooms.uploadTid")}</span>
              <input className="input" value={form.uploadTid} onChange={(e) => set("uploadTid", e.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className="field-label">{t("rooms.uploadDesc")}</span>
              <textarea className="input" rows={2} value={form.uploadDesc} onChange={(e) => set("uploadDesc", e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={form.uploadPrivate} onCheckedChange={(v: boolean) => set("uploadPrivate", v)} />
              <span className="text-sm">{t("rooms.uploadPrivate")}</span>
            </label>
          </div>
        </div>

        {/* ── 节点 ──────────────────────────────────────────────────── */}
        <div className="sm:col-span-2 border-t border-hairline pt-4">
          <h3 className="form-section">{t("rooms.nodes")}</h3>
          <p className="text-xs text-muted mb-2">{t("rooms.nodesHint")}</p>
          <div className="flex flex-wrap gap-2">
            {workers.map((w) => (
              <button key={w.id} type="button" onClick={() => toggleWorker(w.id)}
                className={`btn-small ${form.workers.includes(w.id) ? "btn-secondary" : ""}`}>
                {w.name}
              </button>
            ))}
          </div>
        </div>

        <div className="sm:col-span-2 flex items-center gap-3 pt-2">
          <Button type="submit" disabled={busy}>{busy ? t("rooms.saving") : t("rooms.save")}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
