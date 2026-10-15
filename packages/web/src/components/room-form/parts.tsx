/**
 * 房间表单分区的共用小件:分区标题(可带总开关)与带说明/锁定原因的开关行。
 * 锁定原因一律来自 room-form-rules 的 Lock,这里只负责展示。
 */
import type { ReactNode } from "react";
import { Switch } from "../Switch";
import { useT } from "../../lib/i18n";
import type { Lock } from "../../lib/room-form-rules";

export function SectionHeader({ title, toggle }: {
  title: string;
  toggle?: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean };
}): ReactNode {
  return (
    <div className="form-section flex items-center justify-between gap-3">
      <h3>{title}</h3>
      {toggle && <Switch checked={toggle.checked} onCheckedChange={toggle.onChange} disabled={toggle.disabled} />}
    </div>
  );
}

export function ToggleRow({ label, hint, checked, onChange, lock, lockedChecked, nested, badge }: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** 锁定时开关禁用、显示为关,说明换成锁定原因。 */
  lock?: Lock;
  /** 锁定时开关显示的值(默认关);锁定值本身为开时用。 */
  lockedChecked?: boolean;
  /** 缩进,表示依附于上一行。 */
  nested?: boolean;
  badge?: ReactNode;
}): ReactNode {
  const t = useT();
  const locked = lock?.locked === true;
  return (
    <label className={`switch-row${nested ? " ml-6" : ""}`} data-disabled={locked ? "true" : undefined}>
      <span className="flex flex-col min-w-0">
        <span className="text-sm font-medium text-ink inline-flex items-center gap-1.5">{label}{badge}</span>
        {(locked || hint) && (
          <span className="text-xs text-muted mt-0.5">{locked && lock?.reasonKey ? t(lock.reasonKey) : hint}</span>
        )}
      </span>
      <Switch checked={locked ? lockedChecked === true : checked} onCheckedChange={onChange} disabled={locked} />
    </label>
  );
}

/** 规则总开关:关掉 = 暂停整个房间(各节点停录、录完不处理),不只是「不处理」。 */
export function RuleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): ReactNode {
  const t = useT();
  return <ToggleRow label={t("roomForm.ruleEnabled")} hint={t("roomForm.ruleEnabledHint")} checked={checked} onChange={onChange} />;
}
