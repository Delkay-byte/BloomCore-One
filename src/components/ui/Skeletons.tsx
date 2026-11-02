/**
 * Shared skeleton primitives.
 *
 * Skeletons mirror the shape of the content that is about to appear, so the
 * layout does not jump when data arrives. They are used for initial content
 * loading only: background refreshes keep the existing content on screen and a
 * single button shows its own local loading state.
 *
 * Every skeleton announces itself once through `role="status"`; the animated
 * shapes themselves are hidden from assistive technology. Global
 * `prefers-reduced-motion` rules disable the pulse animation.
 */

import type { CSSProperties } from "react";

export function Skeleton({
  className = "h-4 w-full",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden />;
}

export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={`h-3.5 ${index === lines - 1 ? "w-2/3" : "w-full"}`}
        />
      ))}
    </div>
  );
}

export function SkeletonCircle({ size = 40 }: { size?: number }) {
  return (
    <div
      className="skeleton rounded-full flex-none"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

/** Page header placeholder: title, description and an action button. */
export function SkeletonPageHeader() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-10 w-36 rounded-control" />
    </div>
  );
}

/** Summary/stat cards. */
export function SkeletonStatCards({
  count = 4,
  className = "grid grid-cols-2 gap-4 lg:grid-cols-4",
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="card !p-4 space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

/** Table placeholder with a header row and column-aligned cells. */
export function SkeletonTable({
  rows = 6,
  columns = 5,
  showHeader = true,
}: {
  rows?: number;
  columns?: number;
  showHeader?: boolean;
}) {
  const template = `repeat(${columns}, minmax(0, 1fr))`;
  return (
    <div className="card overflow-hidden p-0" aria-hidden>
      {showHeader && (
        <div
          className="grid gap-4 border-b border-line bg-surface-sunken px-4 py-3"
          style={{ gridTemplateColumns: template }}
        >
          {Array.from({ length: columns }).map((_, index) => (
            <Skeleton key={index} className="h-3 w-24 max-w-full" />
          ))}
        </div>
      )}
      <div className="divide-y divide-line">
        {Array.from({ length: rows }).map((_, row) => (
          <div
            key={row}
            className="grid items-center gap-4 px-4 py-3.5"
            style={{ gridTemplateColumns: template }}
          >
            {Array.from({ length: columns }).map((_, column) => (
              <Skeleton
                key={column}
                className={`h-4 ${column === 0 ? "w-3/4" : "w-1/2"}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Chart card placeholder with a plot area and legend. */
export function SkeletonChart({ height = 288 }: { height?: number }) {
  return (
    <div className="card space-y-4" aria-hidden>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-24 rounded-control" />
      </div>
      <Skeleton className="w-full rounded-control" style={{ height }} />
      <div className="flex gap-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-20" />
      </div>
    </div>
  );
}

/** Form placeholder: labels, inputs, selects and submit actions. */
export function SkeletonForm({ fields = 6 }: { fields?: number }) {
  return (
    <div className="card space-y-5" aria-hidden>
      <Skeleton className="h-5 w-44" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: fields }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-10 w-full rounded-control" />
          </div>
        ))}
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-10 w-32 rounded-control" />
        <Skeleton className="h-10 w-24 rounded-control" />
      </div>
    </div>
  );
}

/** Stacked cards/list rows (customers, staff, devices, notifications). */
export function SkeletonCardList({ items = 4 }: { items?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: items }).map((_, index) => (
        <div key={index} className="card flex items-center gap-4 !p-4">
          <SkeletonCircle size={40} />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-8 w-20 rounded-control" />
        </div>
      ))}
    </div>
  );
}

/** Detail page placeholder: header, summary panel and activity list. */
export function SkeletonDetail() {
  return (
    <div className="space-y-6" aria-hidden>
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card space-y-3 lg:col-span-2">
          <Skeleton className="h-5 w-40" />
          <SkeletonText lines={4} />
          <Skeleton className="h-10 w-44 rounded-control" />
        </div>
        <div className="card space-y-3">
          <Skeleton className="h-5 w-28" />
          <SkeletonText lines={3} />
        </div>
      </div>
      <SkeletonTable rows={5} columns={4} />
    </div>
  );
}

/** Full dashboard placeholder: header, stats, chart and recent activity. */
export function SkeletonDashboard() {
  return (
    <div className="space-y-6" aria-hidden>
      <SkeletonPageHeader />
      <SkeletonStatCards />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SkeletonChart />
        </div>
        <SkeletonCardList items={3} />
      </div>
    </div>
  );
}

export type SkeletonVariant = "dashboard" | "table" | "form" | "detail" | "list";

/**
 * Route-level placeholder. Whatever variant a page picks, the wrapper provides
 * the single polite status announcement so nested skeletons stay silent.
 */
export function SkeletonPage({
  variant = "table",
}: {
  variant?: SkeletonVariant;
}) {
  return (
    <div
      className="w-full space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading content"
    >
      <span className="sr-only">Loading content…</span>
      {variant === "dashboard" && <SkeletonDashboard />}
      {variant === "table" && (
        <>
          <SkeletonPageHeader />
          <SkeletonStatCards count={3} className="grid grid-cols-1 gap-4 sm:grid-cols-3" />
          <SkeletonTable rows={6} columns={5} />
        </>
      )}
      {variant === "form" && (
        <>
          <SkeletonPageHeader />
          <SkeletonForm />
        </>
      )}
      {variant === "detail" && <SkeletonDetail />}
      {variant === "list" && (
        <>
          <SkeletonPageHeader />
          <SkeletonCardList items={5} />
        </>
      )}
    </div>
  );
}
