"use client";

import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ui/Modal";

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (value: boolean) => void;
}

/**
 * Promise-based in-app confirmation. Replaces window.confirm without altering
 * the calling control flow: `if (!(await confirm(message))) return;`.
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback(
    (
      message: string,
      options: { title?: string; confirmLabel?: string } = {}
    ) =>
      new Promise<boolean>((resolve) => {
        setState({
          title: options.title ?? "Confirm action",
          message,
          confirmLabel: options.confirmLabel ?? "Confirm",
          resolve,
        });
      }),
    []
  );

  const close = (value: boolean) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  };

  const confirmNode = (
    <ConfirmDialog
      open={Boolean(state)}
      onClose={() => close(false)}
      onConfirm={() => close(true)}
      title={state?.title ?? "Confirm action"}
      description={state?.message}
      confirmLabel={state?.confirmLabel ?? "Confirm"}
      tone="danger"
    />
  );

  return { confirm, confirmNode };
}
