"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function PlatformConsoleError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[PLATFORM CONSOLE ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load this console page"
      message="Try again. If the problem continues, check the service health before making changes."
      onRetry={retry}
      backHref="/platform/dashboard"
      backLabel="Back to console"
    />
  );
}
