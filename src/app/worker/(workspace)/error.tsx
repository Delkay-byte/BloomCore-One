"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function WorkerError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[WORKER ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load this page"
      message="No daily account figures were changed. Try again, or return to your dashboard."
      onRetry={retry}
      backHref="/worker/dashboard"
      backLabel="Back to dashboard"
    />
  );
}
