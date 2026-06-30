import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type HubRuleDTO, type HubRulePayload } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { errMessage, useToast } from "../lib/hooks";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a rule = edit that rule (roomSlug fixed). */
  rule: HubRuleDTO | null;
  onSaved: () => void;
}

interface FormState {
  room: string;
  enabled: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clStageAfterDone: boolean;
  clIncludeXmlAss: boolean;
  uploadMode: string; // "stage" | "upload"
  uploadPrivate: boolean; // 仅 upload 有意义:true=仅自己可见,false=公开
  uploadTag: string;
  uploadTid: string;
  uploadDesc: string;
}

const BLANK: FormState = {
  room: "",
  enabled: true,
  burnDanmu: true,
  burnLivechat: true,
  clStageSourceAfterMerge: false,
  clSourceAfterDone: false,
  clStageAfterDone: false,
  clIncludeXmlAss: false,
  uploadMode: "stage",
  uploadPrivate: true,
  uploadTag: "",
  uploadTid: "21",
  uploadDesc: "",
};

function fromRule(r: HubRuleDTO): FormState {
  const c = r.pipeline ?? {};
  return {
    room: r.room ?? "",
    enabled: r.enabled,
    burnDanmu: c.steps?.burnDanmu !== false,
    burnLivechat: c.steps?.burnLivechat !== false,
    clStageSourceAfterMerge: c.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: c.cleanup?.sourceAfterDone === true,
    clStageAfterDone: c.cleanup?.stageAfterDone === true,
    clIncludeXmlAss: c.cleanup?.includeXmlAss === true,
    uploadMode: c.upload?.mode === "upload" ? "upload" : "stage",
    uploadPrivate: c.upload?.private !== false,
    uploadTag: c.upload?.tag ?? "",
    uploadTid: String(c.upload?.tid ?? 21),
    uploadDesc: c.upload?.desc ?? "",
  };
}

/** Hub 规则的创建/编辑弹窗:按房间(roomSlug)配置后处理 pipeline。 */
export function HubRuleDialog({ open, onClose, rule, onSaved }: Props): ReactNode {
  const isEdit = rule !== null;
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setForm(rule ? fromRule(rule) : BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    const payload: HubRulePayload = {
      enabled: form.enabled,
      pipeline: {
        steps: { burnDanmu: form.burnDanmu, burnLivechat: form.burnLivechat },
        cleanup: {
          stageSourceAfterMerge: form.clStageSourceAfterMerge,
          sourceAfterDone: form.clSourceAfterDone,
          stageAfterDone: form.clStageAfterDone,
          includeXmlAss: form.clIncludeXmlAss,
        },
        upload: {
          mode: form.uploadMode === "upload" ? "upload" : "stage",
          private: form.uploadPrivate,
          tag: form.uploadTag.trim() || undefined,
          tid: Number(form.uploadTid) || 21,
          desc: form.uploadDesc.trim() || undefined,
        },
      },
    };
    if (!isEdit) payload.room = form.room.trim();
    setBusy(true);
    try {
      if (isEdit) await api.updateHubRule(rule.key, payload);
      else await api.createHubRule(payload);
      onClose();
      toast(isEdit ? "Hub 规则已更新" : "Hub 规则已创建", "success");
      onSaved();
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-2xl"
      title={isEdit ? "编辑 Hub 规则" : "新建 Hub 规则"}
      description="按直播间配置多节点选优合并 → 烧录 → 上传的后处理流程"
    >
      <form className="grid grid-cols-1 sm:grid-cols-2 gap-4" onSubmit={submit}>
        <div className="sm:col-span-2">
          <label className="field-label">
            直播间地址 / room{!isEdit && <span style={{ color: "var(--error)" }}>*</span>}
          </label>
          {isEdit ? (
            <div className="font-mono text-sm text-body break-all">
              {rule.room}
              <span className="text-muted-soft ml-2">(roomSlug: {rule.roomSlug})</span>
            </div>
          ) : (
            <input
              required
              className="input"
              placeholder="https://live.douyin.com/123456 或房间号"
              value={form.room}
              onChange={(e) => set("room", e.target.value)}
            />
          )}
        </div>

        <label className="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
          <span className="flex flex-col">
            <span className="text-sm font-medium text-ink">规则启用 / enabled</span>
            <span className="text-xs text-muted mt-0.5">关闭 = hub 暂停处理此房间(录制不受影响)</span>
          </span>
          <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} name="enabled" />
        </label>

        {/* ── Section: 流水线 pipeline(产出 + 清理)── */}
        <div className="sm:col-span-2">
          <h3 className="text-sm font-semibold text-ink mb-2 pb-1 border-b border-hairline">流水线 / pipeline</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              ["burnDanmu", "烧 danmu / 飞屏弹幕", "合成飞屏弹幕版"],
              ["burnLivechat", "烧 livechat / 聊天框", "合成聊天框版"],
              ["clStageSourceAfterMerge", "合并后删 stage 源 .ts", "留合成产物,删拉来的源片"],
              ["clSourceAfterDone", "完成后删源节点录制", "各节点原始 .ts(完成后)"],
              ["clStageAfterDone", "完成后删 stage 产物", "上传后删合成 mp4"],
              ["clIncludeXmlAss", "删除含 .xml/.ass", "默认只删 .ts/.mp4(守弹幕源)"],
            ] as const).map(([key, label, sub]) => (
              <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{label}</span>
                  <span className="text-xs text-muted mt-0.5">{sub}</span>
                </span>
                <Switch checked={form[key]} onCheckedChange={(v) => set(key, v)} name={key} />
              </label>
            ))}
          </div>
        </div>

        {/* ── Section: Bilibili 上传(总开关 + 开启后才显示投稿明细)── */}
        <div className="sm:col-span-2">
          <h3 className="text-sm font-semibold text-ink mb-2 pb-1 border-b border-hairline">Bilibili 上传 / upload</h3>
          {/* 上传 B站总开关:off=stage(只合成不传) on=upload(自动传) */}
          <label className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
            <span className="flex flex-col">
              <span className="text-sm font-medium text-ink">上传 B站 / bilibili upload</span>
              <span className="text-xs text-muted mt-0.5">{form.uploadMode === "upload" ? "合成后自动投稿(关水印·copyright 自制)" : "只合成,不上传(留 stage 待人工)"}</span>
            </span>
            <Switch
              checked={form.uploadMode === "upload"}
              onCheckedChange={(v) => set("uploadMode", v ? "upload" : "stage")}
              name="uploadOn"
            />
          </label>

          {/* 只有开了上传才显示后面的投稿明细 */}
          {form.uploadMode === "upload" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <label className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">公开 / public</span>
                  <span className="text-xs text-muted mt-0.5">{form.uploadPrivate ? "仅自己可见(默认)" : "公开投稿"}</span>
                </span>
                <Switch checked={!form.uploadPrivate} onCheckedChange={(v) => set("uploadPrivate", !v)} name="uploadPublic" />
              </label>
              <div>
                <label className="field-label">B站分区 tid</label>
                <input type="number" min={1} className="input" value={form.uploadTid} onChange={(e) => set("uploadTid", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">B站 tag(逗号分隔)</label>
                <input className="input" placeholder="直播,录像,…" value={form.uploadTag} onChange={(e) => set("uploadTag", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">B站简介 desc</label>
                <textarea
                  className="input"
                  rows={4}
                  placeholder="(可选,支持多行)"
                  value={form.uploadDesc}
                  onChange={(e) => set("uploadDesc", e.target.value)}
                  style={{ resize: "vertical", minHeight: "5rem", fontFamily: "inherit", whiteSpace: "pre-wrap" }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="sm:col-span-2 flex justify-end gap-3 mt-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy} loading={busy}>
            {isEdit ? "保存" : "创建"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
