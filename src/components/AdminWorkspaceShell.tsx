"use client";

import AppShell from "@/components/AppShell";
import { navSections, type NavSection } from "@/lib/admin-nav";

/**
 * Shared administration shell for both `/admin/*` and `/susu/admin/*`.
 *
 * Module navigation comes from server-resolved tenant entitlement props, so the
 * first frame is correct without a client `/api/auth/me` call. Every page and
 * server action still performs its own authorisation.
 */
export default function AdminWorkspaceShell({
  children,
  tenantName,
  momoEnabled,
  susuEnabled,
  analytics,
  zeliEnabled,
}: {
  children: React.ReactNode;
  tenantName: string | null;
  momoEnabled: boolean;
  susuEnabled: boolean;
  analytics: boolean;
  zeliEnabled: boolean;
}) {
  function visibleSections(): NavSection[] {
    return navSections
      .filter((section) => {
        if (section.title === "MoMo") return momoEnabled;
        if (section.title === "Susu") return susuEnabled;
        return true;
      })
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            (item.href !== "/admin/zeli-analytics" || analytics) &&
            (item.href !== "/zeli" || zeliEnabled)
        ),
      }))
      .filter((section) => section.items.length > 0);
  }

  return (
    <AppShell
      sections={visibleSections()}
      subtitle="Business Management"
      tenantName={tenantName}
    >
      {children}
    </AppShell>
  );
}
