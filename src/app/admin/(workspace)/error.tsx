"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function AdminWorkspaceError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[ADMIN WORKSPACE ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="We couldn't load this page"
      message="The administration workspace hit a problem. Nothing was saved. Try again, or return to the dashboard."
      onRetry={retry}
      backHref="/admin/dashboard"
      backLabel="Back to dashboard"
    />
  );
}
