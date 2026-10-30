import {
  Banknote,
  BookText,
  ClipboardList,
  FileBarChart,
  Footprints,
  Landmark,
  LayoutDashboard,
  MapPin,
  ScrollText,
  Settings,
  UserCog,
  UserRound,
  Users,
  Vault,
  Wallet,
} from "lucide-react";
import type { NavSection } from "@/components/AppShell";

export type { NavSection };

/**
 * Tenant-administrator navigation. Sections are filtered at render time by
 * the TENANT's module entitlement (server-resolved via /api/auth/me) — a
 * business not enrolled for a module never sees its navigation.
 */
export const navSections: NavSection[] = [
  {
    title: "",
    items: [{ href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    title: "MoMo",
    items: [
      { href: "/admin/locations", label: "Locations", icon: MapPin },
      { href: "/admin/workers", label: "Workers", icon: Users },
      { href: "/admin/history", label: "Money & History", icon: BookText },
      { href: "/admin/reports", label: "Reports", icon: ClipboardList },
    ],
  },
  {
    title: "Susu",
    items: [
      { href: "/susu/admin", label: "Overview", icon: Wallet },
      { href: "/susu/admin/customers", label: "Customers", icon: UserRound },
      { href: "/susu/admin/collectors", label: "Collectors", icon: Footprints },
      { href: "/susu/admin/contributions", label: "Contributions", icon: Banknote },
      { href: "/susu/admin/withdrawals", label: "Withdrawals", icon: Landmark },
      { href: "/susu/admin/remittances", label: "Money Handed In", icon: Vault },
      { href: "/susu/admin/history", label: "Money & History", icon: BookText },
      { href: "/susu/admin/reports", label: "Reports", icon: FileBarChart },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/admin/staff", label: "Staff", icon: UserCog },
      { href: "/admin/audit", label: "Activity History", icon: ScrollText },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];
