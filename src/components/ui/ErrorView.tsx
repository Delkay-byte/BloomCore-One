"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/site";

/**
 * Branded, user-facing error panel used by every route error boundary.
 * It never displays the exception message, digest or stack.
 */
export default function ErrorView({
  title = "Something went wrong",
  message = "An unexpected error occurred while loading this page. Your data is safe — no financial records were affected.",
  onRetry,
  backHref = "/login",
  backLabel = "Back to sign in",
  tone = "error",
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  backHref?: string;
  backLabel?: string;
  tone?: "error" | "session";
}) {
  const Icon = tone === "session" ? ShieldAlert : AlertTriangle;
  return (
    <div className="flex min-h-[55vh] items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md text-center" role="alert">
        <Icon
          className={tone === "session" ? "mx-auto mb-3 text-brand-600" : "mx-auto mb-3 text-amber-500"}
          size={32}
          aria-hidden
        />
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{message}</p>
        <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row">
          {onRetry && (
            <button type="button" onClick={onRetry} className="btn btn-primary btn-sm">
              <RefreshCw size={14} aria-hidden /> Try again
            </button>
          )}
          <Link href={backHref} className="btn btn-secondary btn-sm">
            {backLabel}
          </Link>
        </div>
        <p className="mt-4 text-xs text-slate-400">{PRODUCT_NAME}</p>
      </div>
    </div>
  );
}
