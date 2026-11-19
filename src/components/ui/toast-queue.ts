/**
 * Pure queue rules for the toast stack.
 *
 * Kept separate from the provider so they can be tested without a DOM:
 *  - an identical message that is already visible is not pushed twice;
 *  - the stack is capped so it cannot cover the controls it describes;
 *  - the oldest toast is dropped to make room for a new one.
 */
export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastRecord {
  id: number;
  type: ToastType;
  message: string;
}

export const MAX_VISIBLE_TOASTS = 4;

export interface EnqueueResult {
  list: ToastRecord[];
  dropped: number[];
  added: boolean;
}

export function enqueueToast(
  current: ToastRecord[],
  next: ToastRecord,
  max: number = MAX_VISIBLE_TOASTS
): EnqueueResult {
  const message = next.message.trim();
  if (!message) return { list: current, dropped: [], added: false };
  if (current.some((toast) => toast.type === next.type && toast.message === message)) {
    return { list: current, dropped: [], added: false };
  }
  const list = [...current, { ...next, message }];
  const dropped: number[] = [];
  while (list.length > Math.max(1, max)) {
    const removed = list.shift();
    if (removed) dropped.push(removed.id);
  }
  return { list, dropped, added: true };
}
