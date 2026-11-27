"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/susu/admin/reconciliation", label: "Workspace" },
  { href: "/susu/admin/reconciliation/daily-closing", label: "Daily closing" },
  { href: "/susu/admin/reconciliation/branches", label: "Branches" },
  { href: "/susu/admin/reconciliation/exceptions", label: "Exception queue" },
];

/** Shared section navigation. The active tab is read from the current path. */
export default function ReconciliationTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Reconciliation sections"
      className="flex flex-wrap gap-1.5 border-b border-line pb-3"
    >
      {TABS.map((tab) => {
        const active =
          tab.href === "/susu/admin/reconciliation"
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
              active
                ? "bg-brand-700 text-white"
                : "bg-surface-sunken text-ink hover:bg-line"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
