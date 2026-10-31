"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function CustomerDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Customer detail page error:", error);
  }, [error]);

  return (
    <div className="min-h-[50vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="text-4xl mb-4">⚠️</p>
        <h2 className="text-xl font-semibold text-slate-900 mb-2">Unable to load customer</h2>
        <p className="text-slate-500 mb-6">
          Something went wrong while loading this customer&apos;s information.
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={reset} className="btn btn-primary">
            Reload
          </button>
          <Link href="/susu/admin/customers" className="btn btn-secondary">
            Back to Customers
          </Link>
        </div>
      </div>
    </div>
  );
}
