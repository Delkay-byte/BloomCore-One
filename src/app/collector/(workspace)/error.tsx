"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function CollectorError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[COLLECTOR ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load your collections"
      message="Your offline records are still stored on this device. Try again when you have a connection."
      onRetry={retry}
      backHref="/collector/dashboard"
      backLabel="Back to dashboard"
    />
  );
}
