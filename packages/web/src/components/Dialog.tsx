import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";
import { useT } from "../lib/i18n";

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

/** 控制台风格弹窗,基于 Base UI Dialog。 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  widthClass = "max-w-lg",
  center,
  children,
}: Props): ReactNode {
  const t = useT();
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <div className="modal-positioner">
          <BaseDialog.Popup className={`modal-card w-[92vw] ${widthClass} ${center ? "text-center" : ""}`}>
            <div className="modal-header">
              <div className="min-w-0">
                <BaseDialog.Title className="headline text-xl leading-snug">{title}</BaseDialog.Title>
                {description && (
                  <BaseDialog.Description className="modal-desc">{description}</BaseDialog.Description>
                )}
              </div>
              {!center && (
                <IconButton aria-label={t("common.close")} onClick={onClose}>
                  <X className="w-4 h-4" />
                </IconButton>
              )}
            </div>
            {children}
          </BaseDialog.Popup>
        </div>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
