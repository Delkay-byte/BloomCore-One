"use client";

/**
 * Link to the authorised, rate-limited CSV export endpoint.
 *
 * The export is produced server-side from the same filters as the screen, so it
 * always contains the complete filtered set (not the current page) and passes
 * through the server-side formula-injection guard.
 */
export default function ExportReportButton({
  report,
  filters,
}: {
  report: "contributions" | "collectors" | "branches" | "cycles";
  filters: Record<string, string | undefined>;
}) {
  const search = new URLSearchParams({ report });
  for (const [key, value] of Object.entries(filters)) {
    if (value) search.set(key, value);
  }
  return (
    <a href={`/api/susu/reports/export?${search.toString()}`} className="btn btn-secondary btn-sm">
      Export CSV
    </a>
  );
}