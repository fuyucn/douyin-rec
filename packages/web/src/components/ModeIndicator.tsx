/**
 * ModeIndicator — icon-only delivery/capture marks for compact room lists.
 *
 * Icons are never the only label: each mark is a real button with an accessible name from the
 * existing dictionary. Base UI's Popover supplies hover, press and dismissal behaviour (Escape,
 * outside press) while keeping the trigger focusable; the global Tooltip trigger is a non-focusable
 * span, which is why this lives here instead. Keyboard focus opens the same explanation, and only
 * one explanation is open per row. The marks describe configuration; the room status badge still
 * says whether anything is running.
 */
import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RoomDTO } from "../api/client";
import { roomModeIndicators, type RoomIndicator, type RoomIndicatorId } from "../lib/room-mode-indicators";
import { useT } from "../lib/i18n";
import { ModeLogo } from "./ModeLogo";

function Indicator({ data, open, onOpenChange }: {
  data: RoomIndicator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  const t = useT();
  const label = t(data.labelKey);
  const details = (data.detailKeys ?? []).map((key) => t(key));
  const accessibleLabel = [label, ...details].join(" · ");
  const pointerFocus = useRef(false);
  const tone = data.id === "delivery" && data.kind !== "archive" ? "var(--status-fg)" : undefined;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        type="button"
        openOnHover
        delay={80}
        aria-label={accessibleLabel}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-ink"
        style={tone ? { color: tone } : undefined}
        onPointerDown={() => { pointerFocus.current = true; }}
        onPointerCancel={() => { pointerFocus.current = false; }}
        onClick={(event) => {
          event.stopPropagation();
          window.setTimeout(() => { pointerFocus.current = false; }, 0);
        }}
        onFocus={(event) => {
          if (pointerFocus.current && !event.currentTarget.matches(":focus-visible")) return;
          onOpenChange(true);
        }}
      >
        <ModeLogo kind={data.kind} className="mode-chip-icon" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} className="tooltip-positioner">
          <Popover.Popup initialFocus={false} finalFocus={false} className="tooltip-popup" aria-label={accessibleLabel}>
            <div className="flex flex-col gap-1">
              <span className="font-semibold">{label}</span>
              {details.map((detail) => <span key={detail} className="opacity-80">{detail}</span>)}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Compact icon-only indicator group; renders nothing honest for an unconfigured room. */
export function ModeIndicators({ room }: { room: Pick<RoomDTO, "recording" | "processing"> }): ReactNode {
  const [active, setActive] = useState<RoomIndicatorId | null>(null);
  const indicators = roomModeIndicators(room);
  const activeExists = active === null || indicators.some(indicator => indicator.id === active);
  useEffect(() => {
    if (!activeExists) setActive(null);
  }, [activeExists]);
  if (indicators.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-0.5">
      {indicators.map((data) => (
        <Indicator
          key={data.id}
          data={data}
          open={active === data.id}
          onOpenChange={(next) =>
            setActive((current) => (next ? data.id : current === data.id ? null : current))
          }
        />
      ))}
    </span>
  );
}
