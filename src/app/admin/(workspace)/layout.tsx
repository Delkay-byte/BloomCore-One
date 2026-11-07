"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { navSections, type NavSection } from "@/lib/admin-nav";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // Module navigation comes from the TENANT's entitlement (server-resolved via
  // /api/auth/me), never from a browser flag. A business not enrolled for a
  // module must not see — or be invited into — that module's navigation.
  const [modules, setModules] = useState<{ momo: boolean; susu: boolean } | null>(null);
  const [analytics, setAnalytics] = useState(false);
  const [zeliEnabled, setZeliEnabled] = useState(true);
  // The business's own name, shown beside the MaaCash identity so a
  // tenant administrator always sees which workspace they are working in.
  const [tenantName, setTenantName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me?module=admin")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.tenant) {
          setModules({ momo: !!data.tenant.momoEnabled, susu: !!data.tenant.susuEnabled });
          setTenantName(data.tenant.name ?? null);
          setAnalytics(Boolean(data.tenant.zeliAnalytics));
          setZeliEnabled(Boolean(data.tenant.zeliEnabled));
        } else {
          setModules({ momo: true, susu: true });
        }
      })
      .catch(() => !cancelled && setModules({ momo: true, susu: true }));
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the entitlement resolves, show non-module navigation only — the
  // server actions reject disabled modules anyway (fail closed).
  function visibleSections(): NavSection[] {
    const base =
      !modules
        ? navSections.filter((s) => !s.title || s.title === "Administration")
        : navSections.filter((s) => {
            if (s.title === "MoMo") return modules.momo;
            if (s.title === "Susu") return modules.susu;
            return true;
          });
    // Zeli Analytics appears only for a tenant administrator with a live
    // entitlement. The server still denies direct URL/API access.
    return base
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

  // Tab identity is enforced by middleware and every server guard from the
  // per-tab session header. This shell never displays data for a tab that the
  // server has not authenticated.
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
