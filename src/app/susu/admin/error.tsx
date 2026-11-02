"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function SusuAdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[SUSU ADMIN ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load this Susu page"
      message="No financial record was changed. Try again, or return to the Susu dashboard."
      onRetry={retry}
      backHref="/susu/admin"
      backLabel="Back to Susu dashboard"
    />
  );
}
