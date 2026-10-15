import type { ReactNode } from "react";
import { OUTPUT_FORMATS, stageExt, type OutputFormat } from "@drec/output-format";
import { useT } from "../../lib/i18n";
import { qualityLabel } from "../../lib/labels";
import type { Lock } from "../../lib/room-form-rules";
import { SectionHeader, ToggleRow } from "./parts";

export interface RecordingValue {
  recEnabled: boolean;
  name: string;
  quality: string;
  engine: string;
  segmentSec: string;
  schedule: string;
  danmu: boolean;
  useCookie: boolean;
}

/** 「输出格式」下拉(选项来自 core 注册表)。不传 = 不显示(任务弹窗本期不显示)。 */
export interface OutputFormatField {
  /** 所选值(存储口径)。 */
  value: OutputFormat;
  /** 下拉实际显示的值(投稿锁定时恒为 mp4,见 rules 的 shownOutputFormat)。 */
  shown: OutputFormat;
  lock: Lock;
  onChange: (v: OutputFormat) => void;
}

interface Props {
  value: RecordingValue;
  outputFormat?: OutputFormatField;
  onChange: (patch: Partial<RecordingValue>) => void;
  qualities: readonly string[];
  engines: readonly string[];
  danmuAvailable: boolean;
  cookie: Lock;
  /** Cookie 用于取流(B站/快手)时独立成行;抖音上它只服务弹幕,缩进在「录弹幕」下。 */
  cookieForStream: boolean;
  /** 显示标题行的「录制这个房间」开关(任务弹窗不显示:启停在任务列表)。 */
  showEnabled?: boolean;
  showName?: boolean;
  /** 定时窗口下方说明;缺省为通用格式说明。 */
  scheduleHint?: ReactNode;
  /** 弹窗等需要把房间输入框放进本区块时用。 */
  children?: ReactNode;
}

/** 当前值不在候选里(老配置 / 平台改过)时补一项,否则 select 显示空白。 */
function withCurrent(list: readonly string[], current: string): string[] {
  return [...new Set([...list, current].filter(Boolean))];
}

export function RecordingSection(p: Props): ReactNode {
  const t = useT();
  const v = p.value;
  // 文案按平台:抖音取流恒匿名、Cookie 只影响弹幕;B站/快手关掉会掉到匿名基础画质。
  const cookieHint = t(p.cookieForStream ? "rooms.useCookieHintOther" : "rooms.useCookieHintDouyin");
  return (
    <section className="space-y-3">
      <SectionHeader
        title={t("rooms.recordingSection")}
        toggle={p.showEnabled ? { checked: v.recEnabled, onChange: (x) => p.onChange({ recEnabled: x }) } : undefined}
      />
      {p.children}
      <div className="grid grid-cols-2 gap-3">
        {p.showName && (
          <label className="block col-span-2">
            <span className="field-label">{t("rooms.name")}</span>
            <input className="input" value={v.name} onChange={(e) => p.onChange({ name: e.target.value })} />
          </label>
        )}
        <label className="block">
          <span className="field-label">{t("rooms.quality")}</span>
          <select className="input" value={v.quality} onChange={(e) => p.onChange({ quality: e.target.value })}>
            {withCurrent(p.qualities, v.quality).map((q) => <option key={q} value={q}>{qualityLabel(q)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t("rooms.engine")}</span>
          <select className="input" value={v.engine} onChange={(e) => p.onChange({ engine: e.target.value })}>
            {withCurrent(p.engines, v.engine).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t("rooms.segmentSec")}</span>
          <input className="input" type="number" min={0} value={v.segmentSec}
                 onChange={(e) => p.onChange({ segmentSec: e.target.value })} />
        </label>
        <label className="block">
          <span className="field-label">{t("rooms.scheduleWindow")}</span>
          <input className="input font-mono" placeholder="HH:MM-HH:MM" value={v.schedule}
                 onChange={(e) => p.onChange({ schedule: e.target.value })} />
        </label>
        <p className="col-span-2 -mt-1 text-xs text-muted">{p.scheduleHint ?? t("rooms.scheduleHint")}</p>
        {p.outputFormat && (
          <label className="block col-span-2">
            <span className="field-label">{t("rooms.outputFormat")}</span>
            <select className="input" value={p.outputFormat.shown} disabled={p.outputFormat.lock.locked}
                    onChange={(e) => p.outputFormat?.onChange(e.target.value as OutputFormat)}>
              {OUTPUT_FORMATS.map((f) => (
                <option key={f} value={f}>{f === "original" ? t("rooms.outputFormatOriginal") : stageExt(f).slice(1).toUpperCase()}</option>
              ))}
            </select>
            <span className="block mt-1 text-xs text-muted">
              {p.outputFormat.lock.locked && p.outputFormat.lock.reasonKey ? t(p.outputFormat.lock.reasonKey) : t("rooms.outputFormatHint")}
            </span>
          </label>
        )}
      </div>
      <ToggleRow
        label={t("rooms.danmu")}
        hint={p.danmuAvailable ? t("rooms.danmuHint") : t("dialog.danmuNone")}
        checked={v.danmu}
        onChange={(x) => p.onChange({ danmu: x })}
        lock={p.danmuAvailable ? undefined : { locked: true, reasonKey: "dialog.danmuNone" }}
      />
      <ToggleRow
        label={t(p.cookieForStream ? "roomForm.useCookieStream" : "rooms.useCookie")}
        hint={cookieHint}
        checked={v.useCookie}
        onChange={(x) => p.onChange({ useCookie: x })}
        lock={p.cookie}
        nested={!p.cookieForStream}
      />
    </section>
  );
}
