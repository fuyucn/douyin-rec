import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  title: ReactNode;
  /** Optional detail line under the title. */
  message?: ReactNode;
  /** Confirm button label (default: common.confirm). */
  confirmLabel?: string;
  /** Cancel button label (default: common.cancel). */
  cancelLabel?: string;
  /** Red confirm button for destructive actions (delete / clear). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Cal.com-style confirm modal built on Base UI **AlertDialog**(替代 window.confirm)。
 * AlertDialog 语义=必须明确选择(点背景不关、Esc=取消),适合删除/清除这类破坏性确认。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: Props): ReactNode {
  const t = useT();
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="modal-backdrop" />
        <div className="modal-positioner">
          <AlertDialog.Popup className="modal-card w-[92vw] max-w-sm">
            <AlertDialog.Title className="headline text-[19px] mb-1">{title}</AlertDialog.Title>
            {message && (
              <AlertDialog.Description className="text-sm text-muted mb-5">
                {message}
              </AlertDialog.Description>
            )}
            <div className="flex justify-end gap-2">
              <Button small variant="secondary" onClick={onCancel}>
                {cancelLabel ?? t("common.cancel")}
              </Button>
              <Button
                small
                variant="primary"
                onClick={onConfirm}
                style={
                  destructive
                    ? { background: "var(--error)", borderColor: "var(--error)", color: "#fff" }
                    : undefined
                }
              >
                {confirmLabel ?? t("common.confirm")}
              </Button>
            </div>
          </AlertDialog.Popup>
        </div>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
