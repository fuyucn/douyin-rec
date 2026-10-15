/**
 * RoomEditPanel — 房间编辑**右侧滑入面板**(T20 第 1 步)。
 *
 * 为什么用面板而不是居中弹窗:字段多(录制 + 处理 + 上传 + 节点),纵向长表单在右侧面板里最自然,
 * 且与「Hub 房间详情」「Worker 管理」保持同一套滑入交互(本项目既有标准)。
 *
 * 录制半边 + 处理半边同处一屏,保存走 `PUT /api/rooms/:key` —— 后端**先写 task、再写规则,
 * 第二步失败回滚第一步**,不会出现「画质改了但处理没改」的半成功(T9 的设计要点)。
 * 字段分区与依赖由 components/room-form + lib/room-form-rules 统一提供(issue #126)。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { api, type PlatformDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { CleanupSection, type CleanupValue } from "../components/room-form/CleanupSection";
import { FlowSummary } from "../components/room-form/FlowSummary";
import { NodesSection } from "../components/room-form/NodesSection";
import { NotifySection } from "../components/room-form/NotifySection";
import { ProcessingSection, type ProcessingValue } from "../components/room-form/ProcessingSection";
import { RecordingSection, type RecordingValue } from "../components/room-form/RecordingSection";
import { RuleSwitch } from "../components/room-form/parts";
import { UploadSection, type UploadValue } from "../components/room-form/UploadSection";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, splitSchedule } from "../lib/labels";
import {
  deriveConstraints, flowSummary, methodFromStored, settledMethod, storedFromForm, type FormFacts,
} from "../lib/room-form-rules";

interface Props {
  open: boolean;
  room: RoomDTO;
  onClose: () => void;
  onSaved: () => void;
}

type FormState = RecordingValue & ProcessingValue & UploadValue & CleanupValue & {
  webhook: string;
  workers: string[];
  requires: string[];
};

function fromRoom(r: RoomDTO): FormState {
  const rec = r.recording;
  const p = r.processing?.pipeline ?? {};
  return {
    name: rec?.name ?? "",
    quality: rec?.quality ?? "",
    engine: rec?.engine ?? "",
    segmentSec: String(rec?.segmentSec ?? 1800),
    schedule: rec?.scheduleStart && rec?.scheduleEnd ? `${rec.scheduleStart}-${rec.scheduleEnd}` : "",
    webhook: rec?.webhook ?? "",
    danmu: !!rec?.danmu,
    useCookie: rec?.useCookie ?? true,
    recEnabled: rec?.enabled ?? true,
    procEnabled: r.processing?.enabled ?? true,
    // 烧录缺省 = 开(与后端 burnFlags 同口径 `!== false`);按 `=== true` 读会把「没写 steps」显示成关,保存即静默写入烧录关。
    burnDanmu: p.steps?.burnDanmu !== false,
    burnLivechat: p.steps?.burnLivechat !== false,
    mergeSegments: p.steps?.mergeSegments !== false,
    tsDirect: p.steps?.tsDirect === true,
    ...methodFromStored(p.upload?.mode, p.steps?.nodeSideUpload === true),
    clStageSourceAfterMerge: p.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: p.cleanup?.sourceAfterDone === true,
    clStageAfterDone: p.cleanup?.stageAfterDone === true,
    uploadPrivate: p.upload?.private !== false,
    tag: p.upload?.tag ?? "",
    tid: String(p.upload?.tid ?? 21),
    desc: p.upload?.desc ?? "",
    titleTemplate: p.upload?.titleTemplate ?? "",
    submissionTitleTemplate: p.upload?.submissionTitleTemplate ?? "",
    partTitleTemplate: p.upload?.partTitleTemplate ?? "",
    requires: r.processing?.requires ?? [],
    workers: r.processing?.workers ?? [],
  };
}

export function RoomEditPanel({ open, room, onClose, onSaved }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const cookieReady = !!useAtomValue(cookieStatusAtom)?.hasSession;
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
  // Cookie 的含义按平台不同:抖音取流恒匿名(会话 cookie 会踢主号,见 docs/douyin-kick-investigation.md),
  // 只影响弹幕礼物/入场;B站/快手用它取流。
  const factsOf = (f: FormState): FormFacts => ({
    ...f,
    danmuAvailable: plat ? plat.hasDanmu : true,
    cookieReady,
    cookieForStream: room.platform !== "douyin",
    hasRule: room.processing != null,
  });
  const facts = factsOf(form);
  const c = deriveConstraints(facts);
  // 每次改动后结算上传方式:开烧录 / 加节点让所选方式失效时自动回落,不留「看着开着其实没生效」。
  const update = (patch: Partial<FormState>): void =>
    setForm((f) => {
      const next = { ...f, ...patch };
      return { ...next, method: settledMethod(factsOf(next)) };
    });
  const toggleIn = (list: string[], x: string): string[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    const sched = splitSchedule(form.schedule);
    if (!sched) { toast(t("rooms.scheduleInvalid"), "error"); return; }
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
            ...sched,
            webhook: form.webhook.trim() || null,
          }
        : undefined;
      const stored = storedFromForm(facts);
      await api.updateRoom(room.key, {
        ...(recording ? { recording } : {}),
        processing: {
          enabled: form.procEnabled,
          workers: form.workers,
          requires: form.requires,
          pipeline: {
            steps: {
              mergeSegments: form.mergeSegments,
              burnDanmu: stored.burnDanmu,
              burnLivechat: stored.burnLivechat,
              nodeSideUpload: stored.nodeSideUpload,
              tsDirect: form.tsDirect,
            },
            cleanup: {
              stageSourceAfterMerge: form.clStageSourceAfterMerge,
              sourceAfterDone: form.clSourceAfterDone,
              stageAfterDone: form.clStageAfterDone,
            },
            upload: {
              mode: stored.mode,
              private: form.uploadPrivate,
              tag: form.tag.trim() || undefined,
              tid: Number(form.tid) || 21,
              desc: form.desc.trim() || undefined,
              titleTemplate: form.titleTemplate.trim() || undefined,
              submissionTitleTemplate: form.submissionTitleTemplate.trim() || undefined,
              partTitleTemplate: form.partTitleTemplate.trim() || undefined,
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

        <form onSubmit={submit} className="px-4 sm:px-5 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-7">
          <FlowSummary steps={flowSummary(facts, !!room.recording && form.recEnabled)} />
          <RuleSwitch checked={form.procEnabled} onChange={(procEnabled) => update({ procEnabled })} />
          {room.recording ? (
            <RecordingSection value={form} onChange={update} showEnabled showName
                              qualities={plat?.qualities ?? []} engines={plat?.engines ?? []}
                              danmuAvailable={facts.danmuAvailable} cookie={c.cookie} cookieForStream={facts.cookieForStream} />
          ) : (
            <p className="text-xs text-muted">{t("rooms.onlyRule")}</p>
          )}
          <NodesSection workers={workers} selected={form.workers} requires={form.requires}
                        onToggle={(id) => update({ workers: toggleIn(form.workers, id) })}
                        onToggleRequire={(cap) => update({ requires: toggleIn(form.requires, cap) })} />
          <ProcessingSection value={form} onChange={update} burn={c.burn} />
          <UploadSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled}
                         anchorName={room.recording?.name || room.recording?.anchorName || room.roomSlug} />
          <CleanupSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled} />
          {room.recording && <NotifySection webhook={form.webhook} onChange={(webhook) => update({ webhook })} />}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
            <Button type="submit" disabled={busy}>{busy ? t("rooms.saving") : t("rooms.save")}</Button>
          </div>
        </form>
      </aside>
    </>
  );
}
