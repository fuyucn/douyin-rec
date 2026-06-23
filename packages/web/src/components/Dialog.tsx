import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";

interface Props {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional subtitle line under the title. */
  description?: ReactNode;
  /** Width utility class for the card (e.g. "max-w-2xl"). */
  widthClass?: string;
  /** Center the card content (used by the QR dialog). */
  center?: boolean;
  children: ReactNode;
}

/** Cal.com-style modal built on Base UI Dialog. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  widthClass = "max-w-lg",
  center,
  children,
}: Props): ReactNode {
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <div className="modal-positioner">
          <BaseDialog.Popup className={`modal-card w-[92vw] ${widthClass} ${center ? "text-center" : ""}`}>
            <div className={`flex items-start justify-between ${description ? "mb-1" : "mb-4"}`}>
              <BaseDialog.Title className="headline text-[22px]">{title}</BaseDialog.Title>
              {!center && (
                <IconButton aria-label="关闭" onClick={onClose}>
                  <X className="w-4 h-4" />
                </IconButton>
              )}
            </div>
            {description && (
              <BaseDialog.Description className="text-sm text-muted mb-4">
                {description}
              </BaseDialog.Description>
            )}
            {children}
          </BaseDialog.Popup>
        </div>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
