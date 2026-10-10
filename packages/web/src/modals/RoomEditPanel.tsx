/**
 * RoomEditPanel — 房间编辑**右侧滑入面板**(T20 第 1 步)。
 *
 * 为什么用面板而不是居中弹窗:字段多(录制 7 项 + 处理 10 项 + 节点),
 * 居中弹窗在窄屏会挤成一列、宽屏又留大片空白;右侧面板是**纵向长表单**的自然形态,
 * 且与「Hub 房间详情」「Worker 管理」保持同一套滑入交互(本项目既有标准)。
 *
 * 录制半边 + 处理半边同处一屏,保存走 `PUT /api/rooms/:key` —— 后端**先写 task、再写规则,
 * 第二步失败回滚第一步**,不会出现「画质改了但处理没改」的半成功(T9 的设计要点)。
 *
 * 旧弹窗(CreateEditTaskDialog / HubRuleDialog)一律不动;本面板只服务 /rooms 页。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { api, type PlatformDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { Button, IconButton } from "../components/Button";
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
  name: string;
  quality: string;
  engine: string;
  segmentSec: string;
  danmu: boolean;
  useCookie: boolean;
  recEnabled: boolean;
  procEnabled: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  mergeSegments: boolean;
  nodeSideUpload: boolean;
  uploadMode: string;
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

export function RoomEditPanel({ open, room, onClose, onSaved }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromRoom(room));
  const [busy, setBusy] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);

  useEffect(() => { setForm(fromRoom(room)); }, [room.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 关闭(与 Worker 面板同款)。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      // recording 只在有录制任务时才发 —— 纯规则房间不该被造出 task(后端也会挡)。
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
      // 后端失败信息会说明「哪一半失败、是否已回滚」—— 原样展示,不吞。
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const roomName = room.recording?.name || room.recording?.anchorName || room.roomSlug;

  return (
    <>
      <div className="modal-backdrop" style={{ opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity 0.18s ease" }} onClick={onClose} />
      <aside
        className="fixed top-0 right-0 h-full w-full sm:w-[92vw] sm:max-w-[560px] overflow-y-auto"
        style={{ zIndex: 101, background: "var(--raised)", borderLeft: "1px solid var(--hairline)", boxShadow: "var(--shadow-slide)", transform: open ? "translateX(0)" : "translateX(100%)", transition: "transform 0.22s ease" }}
        role="dialog" aria-modal="true"
      >
        {/* 头部:标题 = 房间名;副标题 = room key(与其它面板一致) */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 pt-5 pb-3 sticky top-0 z-10"
             style={{ background: "var(--raised)", borderBottom: "1px solid var(--hairline)" }}>
          <div className="min-w-0">
            <h2 className="headline text-[20px] leading-tight truncate">{roomName}</h2>
            <p className="text-muted text-xs mt-1 font-mono truncate" title={room.room}>{room.platform} · {room.roomSlug}</p>
          </div>
          <IconButton title={t("hub.workers.close")} onClick={onClose}><X className="w-4 h-4" /></IconButton>
        </div>

        <form onSubmit={submit} className="px-4 sm:px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-6">
          {/* ── 录制 ─────────────────────────────────────────────────── */}
          <section>
            <h3 className="form-section">{t("rooms.recordingSection")}</h3>
            {!room.recording ? (
              <p className="text-xs text-muted">{t("rooms.onlyRule")}</p>
            ) : (
              <div className="space-y-3">
                <label className="switch-row">
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{t("rooms.recEnabledLabel")}</span>
                    <span className="text-xs text-muted mt-0.5">{t("rooms.recEnabledHint")}</span>
                  </span>
                  <Switch checked={form.recEnabled} onCheckedChange={(v: boolean) => set("recEnabled", v)} />
                </label>
                {/* 名称 + 画质/引擎:字段短,窄屏两列不截断 */}
                <div className="grid grid-cols-2 gap-3">
                  <label className="block col-span-2">
                    <span className="field-label">{t("rooms.name")}</span>
                    <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
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
                  <label className="block">
                    <span className="field-label">{t("rooms.segmentSec")}</span>
                    <input className="input" type="number" min={60} value={form.segmentSec} onChange={(e) => set("segmentSec", e.target.value)} />
                  </label>
                  {/* 这两个开关带说明文字(两行标准),说明是长句 → 单列全宽,避免截断 */}
                  <label className="switch-row col-span-2">
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-ink">{t("rooms.danmu")}</span>
                      <span className="text-xs text-muted mt-0.5">{t("rooms.danmuHint")}</span>
                    </span>
                    <Switch checked={form.danmu} onCheckedChange={(v: boolean) => set("danmu", v)} />
                  </label>
                  <label className="switch-row col-span-2">
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-ink">{t("rooms.useCookie")}</span>
                      <span className="text-xs text-muted mt-0.5">{t("rooms.useCookieHint")}</span>
                    </span>
                    <Switch checked={form.useCookie} onCheckedChange={(v: boolean) => set("useCookie", v)} />
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* ── 处理 ─────────────────────────────────────────────────── */}
          <section>
            <h3 className="form-section">{t("rooms.processingSection")}</h3>
            <div className="space-y-3">
              <label className="switch-row">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{t("rooms.procEnabledLabel")}</span>
                  <span className="text-xs text-muted mt-0.5">{t("rooms.procEnabledHint")}</span>
                </span>
                <Switch checked={form.procEnabled} onCheckedChange={(v: boolean) => set("procEnabled", v)} />
              </label>
              {/* 步骤开关:说明是长句(如合并的取舍),**一律单列全宽** —— 两列会把说明截成 「...each」看不清 */}
              <div className="space-y-3">
                <label className="switch-row">
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-ink">{t("rooms.mergeSegments")}</span>
                    <span className="text-xs text-muted mt-0.5">{t("hub.ruleDialog.toggleMergeSegmentsSub")}</span>
                  </span>
                  <Switch checked={form.mergeSegments} onCheckedChange={(v: boolean) => set("mergeSegments", v)} />
                </label>
                <label className="switch-row">
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-ink">{t("rooms.burnDanmu")}</span>
                    <span className="text-xs text-muted mt-0.5">{t("hub.ruleDialog.toggleBurnDanmuSub")}</span>
                  </span>
                  <Switch checked={form.burnDanmu} onCheckedChange={(v: boolean) => set("burnDanmu", v)} />
                </label>
                <label className="switch-row">
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-ink">{t("rooms.burnLivechat")}</span>
                    <span className="text-xs text-muted mt-0.5">{t("hub.ruleDialog.toggleBurnLivechatSub")}</span>
                  </span>
                  <Switch checked={form.burnLivechat} onCheckedChange={(v: boolean) => set("burnLivechat", v)} />
                </label>
                <label className="switch-row" data-disabled={form.burnDanmu || form.burnLivechat ? "true" : undefined}>
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-ink">{t("rooms.nodeSideUpload")}</span>
                    {/* 与烧录互斥(弱节点烧不动):开烧录时该说明换成禁用原因,不让用户开了却静默不生效 */}
                    <span className="text-xs text-muted mt-0.5">
                      {(form.burnDanmu || form.burnLivechat) ? t("rooms.nodeSideUploadDisabled") : t("hub.ruleDialog.toggleNodeSideUploadSub")}
                    </span>
                  </span>
                  <Switch checked={form.nodeSideUpload} onCheckedChange={(v: boolean) => set("nodeSideUpload", v)} disabled={form.burnDanmu || form.burnLivechat} />
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
                <label className="switch-row">
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-ink truncate">{t("rooms.uploadPrivate")}</span>
                    <span className="text-xs text-muted mt-0.5">
                      {form.uploadPrivate ? t("hub.ruleDialog.privateHint") : t("hub.ruleDialog.publicHint")}
                    </span>
                  </span>
                  <Switch checked={form.uploadPrivate} onCheckedChange={(v: boolean) => set("uploadPrivate", v)} />
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
                  <textarea className="input" rows={3} value={form.uploadDesc} onChange={(e) => set("uploadDesc", e.target.value)} />
                </label>
              </div>
            </div>
          </section>

          {/* ── 参与节点 ─────────────────────────────────────────────── */}
          <section>
            <h3 className="form-section">{t("rooms.nodes")}</h3>
            <p className="text-xs text-muted mb-2">{t("rooms.nodesHint")}</p>
            {workers.length === 0 ? (
              <p className="text-xs text-muted">{t("rooms.nodesEmpty")}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {workers.map((w) => (
                  <label key={w.id} className="switch-row">
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm font-medium text-ink truncate">{w.name}</span>
                      <span className="text-xs text-muted mt-0.5 font-mono truncate">{w.kind}{w.host ? ` · ${w.host}` : ""}</span>
                    </span>
                    <Switch checked={form.workers.includes(w.id)} onCheckedChange={() => toggleWorker(w.id)} />
                  </label>
                ))}
              </div>
            )}
          </section>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
            <Button type="submit" disabled={busy}>{busy ? t("rooms.saving") : t("rooms.save")}</Button>
          </div>
        </form>
      </aside>
    </>
  );
}
