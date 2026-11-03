"use client";

import { useCallback, useRef, useState } from "react";
import { toUserMessage } from "@/lib/errors/friendly";

export interface OptimisticRunOptions<T> {
  /** Apply the expected result immediately. */
  apply: () => void | Promise<void>;
  /** Restore the previous state when the server rejects the change. */
  rollback: () => void | Promise<void>;
  /** The server operation. */
  action: () => Promise<T & { success: boolean; error?: string }>;
  onSuccess?: (result: T & { success: boolean; error?: string }) => void;
  onError?: (message: string) => void;
}

/**
 * Apply an optimistic change, then keep or roll it back from the server
 * answer. Exported separately from the hook so the behaviour can be tested
 * without a React renderer.
 */
export async function performOptimistic<T>(
  options: OptimisticRunOptions<T>
): Promise<(T & { success: boolean; error?: string }) | null> {
  await options.apply();

  try {
    const result = await options.action();
    if (result.success) {
      options.onSuccess?.(result);
      return result;
    }
    await options.rollback();
    options.onError?.(
      result.error || "The change could not be saved. Please try again."
    );
    return result;
  } catch (error) {
    await options.rollback();
    options.onError?.(toUserMessage(error).message);
    return null;
  }
}

/**
 * Optimistic update for safe, reversible operations (status toggles,
 * preferences, ordinary drafts). It never marks a financial posting as
 * successful: callers must keep financial confirmations tied to the server
 * response.
 *
 * A second call while one is in flight is ignored, so a double click cannot
 * send two requests.
 */
export function useOptimisticAction() {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const run = useCallback(async <T,>(options: OptimisticRunOptions<T>) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);

    try {
      return await performOptimistic(options);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return { run, pending };
}
