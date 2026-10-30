/**
 * Shared data-display primitives: badges, empty states, skeletons, page
 * headers, statistic cards, pagination and active-filter chips.
 *
 * Server-component safe: only FilterChips is interactive ("use client"
 * isolated in its own file) — everything else renders plain markup so both
 * server and client pages can import them.
 */
import Link from "next/link";
import { ChevronLeft, ChevronRight, SearchX } from "lucide-react";

/* ---------------------------------------------------------------------------
 * Status indicators — every status renders an icon shape + text so meaning
 * never relies on colour alone.
 * ------------------------------------------------------------------------- */

const STATUS_MAP: Record<string, { cls: string; dot: string; label?: string }> = {
  // generic
  active: { cls: "badge-green", dot: "bg-emerald-600" },
  inactive: { cls: "badge-gray", dot: "bg-slate-400" },
  suspended: { cls: "badge-red", dot: "bg-red-600" },
  // daily accounts
  draft: { cls: "badge-gray", dot: "bg-slate-400" },
  submitted: { cls: "badge-yellow", dot: "bg-amber-500" },
  reviewed: { cls: "badge-green", dot: "bg-emerald-600" },
  // susu
  completed: { cls: "badge-green", dot: "bg-emerald-600" },
  pending: { cls: "badge-yellow", dot: "bg-amber-500" },
  rejected: { cls: "badge-red", dot: "bg-red-600" },
  reconciled: { cls: "badge-green", dot: "bg-emerald-600" },
  discrepancy: { cls: "badge-red", dot: "bg-red-600" },
  pending_sync: { cls: "badge-yellow", dot: "bg-amber-500", label: "Pending sync" },
  synced: { cls: "badge-green", dot: "bg-emerald-600" },
  failed: { cls: "badge-red", dot: "bg-red-600" },
  closed: { cls: "badge-gray", dot: "bg-slate-400" },
  // tenants (platform)
  PROVISIONING: { cls: "badge-yellow", dot: "bg-amber-500", label: "Provisioning" },
  ACTIVE: { cls: "badge-green", dot: "bg-emerald-600", label: "Active" },
  SUSPENDED: { cls: "badge-red", dot: "bg-red-600", label: "Suspended" },
  ARCHIVED: { cls: "badge-gray", dot: "bg-slate-400", label: "Archived" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const meta = STATUS_MAP[status] ?? { cls: "badge-gray", dot: "bg-slate-400" };
  return (
    <span className={`badge ${meta.cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {label ?? meta.label ?? status.replace(/_/g, " ")}
    </span>
  );
}

/** Back-compat alias used by existing pages that call getStatusColor(). */
export function Badge({
  tone = "gray",
  children,
}: {
  tone?: "green" | "red" | "yellow" | "blue" | "gray" | "brand" | "gold";
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/* ---------------------------------------------------------------------------
 * Empty / error states
 * ------------------------------------------------------------------------- */

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      {icon && (
        <div className="text-brand-300 mb-3 [&>svg]:h-10 [&>svg]:w-10" aria-hidden>
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="text-sm text-slate-500 mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  message = "Something went wrong while loading this page.",
  onRetry,
  onRetryHref,
}: {
  message?: string;
  onRetry?: () => void;
  onRetryHref?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
      <p className="text-sm font-semibold text-red-700">Unable to load</p>
      <p className="text-sm text-slate-500 mt-1 max-w-sm">{message}</p>
      {(onRetry || onRetryHref) && (
        <div className="mt-4">
          {onRetryHref ? (
            <Link href={onRetryHref} className="btn btn-secondary btn-sm">
              Go back
            </Link>
          ) : (
            <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function NoResults({ hint }: { hint?: string }) {
  return (
    <EmptyState
      icon={<SearchX />}
      title="No matching results"
      hint={hint ?? "Try adjusting or clearing your filters."}
    />
  );
}

/* ---------------------------------------------------------------------------
 * Skeletons
 * ------------------------------------------------------------------------- */

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Standard page-level loading skeleton: header + 3 stat cards + table rows. */
export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-1" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`h-10 ${i % 2 ? "w-full" : "w-[97%]"}`} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Page header — consistent title/description/primary-action placement.
 * ------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{title}</h1>
        {description && <p className="text-sm text-slate-500 mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 flex-none">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Statistic card — compact, meaning-first; never a grid of identical boxes.
 * ------------------------------------------------------------------------- */

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
  href,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "positive" | "negative" | "warning" | "brand";
  icon?: React.ReactNode;
  href?: string;
}) {
  const valueCls =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "negative"
        ? "text-red-700"
        : tone === "warning"
          ? "text-amber-700"
          : tone === "brand"
            ? "text-brand-700"
            : "text-slate-900";
  const body = (
    <div className="card !p-4 h-full">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
        {icon && <span className="text-brand-300 [&>svg]:h-4 [&>svg]:w-4" aria-hidden>{icon}</span>}
      </div>
      <p className={`text-2xl font-bold mt-1.5 tnum ${valueCls}`}>{value}</p>
      {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-[0.75rem] focus-visible:outline-brand-600 hover:shadow-[0_2px_6px_-1px_rgb(15_23_42/0.08)] transition-shadow">
      {body}
    </Link>
  ) : (
    body
  );
}

/* ---------------------------------------------------------------------------
 * Pagination — server-driven; renders nothing when there is one page.
 * ------------------------------------------------------------------------- */

export function Pagination({
  page,
  pages,
  total,
  makeHref,
}: {
  page: number;
  pages: number;
  total?: number;
  makeHref: (page: number) => string;
}) {
  if (pages <= 1) {
    return total != null ? (
      <p className="text-xs text-slate-400 px-1">{total} {total === 1 ? "record" : "records"}</p>
    ) : null;
  }
  return (
    <nav className="flex items-center justify-between" aria-label="Pagination">
      <p className="text-xs text-slate-500">
        Page {page} of {pages}
        {total != null ? ` · ${total} records` : ""}
      </p>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={makeHref(page - 1)}
            className="btn btn-secondary btn-sm"
            aria-label={`Previous page, page ${page - 1}`}
          >
            <ChevronLeft size={14} aria-hidden /> Previous
          </Link>
        )}
        {page < pages && (
          <Link
            href={makeHref(page + 1)}
            className="btn btn-secondary btn-sm"
            aria-label={`Next page, page ${page + 1}`}
          >
            Next <ChevronRight size={14} aria-hidden />
          </Link>
        )}
      </div>
    </nav>
  );
}
