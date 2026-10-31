"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { PRODUCT_NAME } from "@/lib/site";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for monitoring without leaking internals to the UI.
    console.error("[PAGE ERROR]", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="card max-w-md w-full text-center">
        <AlertTriangle className="mx-auto text-amber-500 mb-3" size={32} aria-hidden />
        <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
        <p className="text-sm text-slate-500 mt-2">
          An unexpected error occurred while rendering this page. Your data is safe —
          no financial records were affected.
        </p>
        <div className="flex justify-center gap-2 mt-5">
          <button type="button" onClick={reset} className="btn btn-primary btn-sm">
            Try again
          </button>
          <Link href="/login" className="btn btn-secondary btn-sm">
            Back to sign in
          </Link>
        </div>
        <p className="text-xs text-slate-400 mt-4">{PRODUCT_NAME}</p>
      </div>
    </div>
  );
}
