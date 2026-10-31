"use client";

import AppShell from "@/components/AppShell";
import { navSections } from "@/lib/admin-nav";

export default function SusuAdminLayout({ children }: { children: React.ReactNode }) {
  // The Susu workspace shares the tenant-administration shell and navigation.
  // Module entitlement for the Susu section is enforced server-side by every
  // action (fail closed) and filtered in the admin layout for /admin/* pages.
  return (
    <AppShell sections={navSections} subtitle="Business Management">
      {children}
    </AppShell>
  );
}
