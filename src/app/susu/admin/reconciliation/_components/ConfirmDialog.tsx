"use client";

import type { ReactNode } from "react";
import Modal from "@/components/ui/Modal";

/**
 * Consequential action confirmation. The caller supplies the exact wording and
 * the server still re-validates every condition; this only prevents an
 * accidental click on a cash or case action.
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <>
                <span className="spinner spinner-sm" aria-hidden /> Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
