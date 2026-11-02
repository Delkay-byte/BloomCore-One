"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function CustomerPortalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[CUSTOMER PORTAL ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load your account"
      message="Your savings records are safe. Try again, or return to your dashboard."
      onRetry={retry}
      backHref="/customer/dashboard"
      backLabel="Back to dashboard"
    />
  );
}
