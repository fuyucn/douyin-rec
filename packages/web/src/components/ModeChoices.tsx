/**
 * ModeChoices — a compact radio-card group for delivery modes (archive/upload, timing, output).
 *
 * Each option carries its own mark + one-line explanation so the choice is legible without hovering
 * or opening another step. The selected option uses the app's one selection style: ink outline.
 */
import type { ReactNode } from "react";
import { ModeLogo, type ModeLogoKind } from "./ModeLogo";

export interface ModeChoice<T extends string> {
  id: T;
  label: string;
  hint?: string;
  icon: ModeLogoKind;
  disabled?: boolean;
  disabledReason?: string;
}

export function ModeChoices<T extends string>({ items, value, onChange, columns = 2, small }: {
  items: readonly ModeChoice<T>[];
  value: T;
  onChange: (v: T) => void;
  columns?: 2 | 3;
  small?: boolean;
}): ReactNode {
  return (
    <div role="radiogroup" className={`mode-cards${columns === 3 ? " mode-cards-3" : ""}${small ? " mode-cards-sm" : ""}`}>
      {items.map((it) => {
        const active = value === it.id;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={it.disabled}
            title={it.disabled ? it.disabledReason : undefined}
            className={`mode-card${active ? " is-active" : ""}`}
            onClick={() => onChange(it.id)}
          >
            <span className="mode-card-icon" aria-hidden="true"><ModeLogo kind={it.icon} /></span>
            <span className="mode-card-copy">
              <span className="mode-card-title">{it.label}</span>
              {it.hint && <span className="mode-card-hint">{it.hint}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
