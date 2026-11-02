"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

/**
 * Application-level error boundary.
 *
 * Next.js 16 passes `retry()` (re-fetches and re-renders the segment). The
 * fallback to `reset()` keeps older callers working. Internal details stay in
 * the console/monitoring layer, never in the UI.
 */
export default function Error({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error("[PAGE ERROR]", error);
  }, [error]);

  return <ErrorView onRetry={retry ?? reset} backHref="/" backLabel="Go to homepage" />;
}
