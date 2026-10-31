import { StatusBadge } from "@/components/ui/DataDisplay";
import { TENANT_ONBOARDING, TENANT_STATUSES } from "@/lib/platform-shared";

/**
 * Shared display helpers for the platform console.
 * Status rendering delegates to the shared StatusBadge primitive.
 */

export { TENANT_STATUSES, TENANT_ONBOARDING };

export function tenantStatusBadge(status: string) {
  return <StatusBadge status={status} />;
}

export function moduleBadge(momo: boolean, susu: boolean) {
  const label = momo && susu ? "MoMo + Susu" : momo ? "MoMo only" : susu ? "Susu only" : "No modules";
  return (
    <span className="badge badge-brand whitespace-nowrap">
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
