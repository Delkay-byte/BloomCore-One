/**
 * Shared display helpers for the platform console.
 * Kept framework-free so server and client components can both import them.
 */

export const TENANT_STATUSES = ["PROVISIONING", "ACTIVE", "SUSPENDED", "ARCHIVED"] as const;
export const TENANT_ONBOARDING = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"] as const;

export function tenantStatusBadge(status: string) {
  const map: Record<string, { label: string; className: string }> = {
    PROVISIONING: { label: "Provisioning", className: "bg-amber-50 text-amber-700 border-amber-200" },
    ACTIVE: { label: "Active", className: "bg-green-50 text-green-700 border-green-200" },
    SUSPENDED: { label: "Suspended", className: "bg-red-50 text-red-700 border-red-200" },
    ARCHIVED: { label: "Archived", className: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  const badge = map[status] ?? { label: status, className: "bg-gray-100 text-gray-600 border-gray-200" };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-medium whitespace-nowrap ${badge.className}`}>
      {badge.label}
    </span>
  );
}

export function moduleBadge(momo: boolean, susu: boolean) {
  const label = momo && susu ? "MoMo + Susu" : momo ? "MoMo only" : susu ? "Susu only" : "No modules";
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">
      {label}
    </span>
  );
}

export function onboardingLabel(status: string): string {
  const map: Record<string, string> = {
    NOT_STARTED: "Not started",
    IN_PROGRESS: "In progress",
    COMPLETED: "Completed",
  };
  return map[status] ?? status;
}
