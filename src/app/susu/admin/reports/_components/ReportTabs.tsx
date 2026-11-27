"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/susu/admin/reports/overview", label: "Overview" },
  { href: "/susu/admin/reports/contributions", label: "Contributions" },
  { href: "/susu/admin/reports/collectors", label: "Collectors" },
  { href: "/susu/admin/reports/branches", label: "Branches" },
  { href: "/susu/admin/reports/cycles", label: "Cycles" },
  { href: "/susu/admin/reports/customers", label: "Customer statements" },
  { href: "/susu/admin/reports", label: "Transaction lists" },
];

/** Shared section navigation for the Susu reporting pages. */
export default function ReportTabs() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Report sections"
      className="flex flex-wrap gap-1.5 border-b border-line pb-3"
    >
      {TABS.map((tab) => {
        const active =
          tab.href === "/susu/admin/reports"
            ? pathname === tab.href
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
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