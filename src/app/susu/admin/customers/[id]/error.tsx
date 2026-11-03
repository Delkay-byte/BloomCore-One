"use client";

import { useEffect } from "react";
import ErrorView from "@/components/ui/ErrorView";

export default function CustomerDetailError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    console.error("[CUSTOMER DETAIL ERROR]", error);
  }, [error]);

  return (
    <ErrorView
      title="Unable to load customer"
      message="We couldn't load this customer's information. No records were changed. Try again, or go back to the customer list."
      onRetry={retry}
      backHref="/susu/admin/customers"
      backLabel="Back to customers"
    />
  );
}
