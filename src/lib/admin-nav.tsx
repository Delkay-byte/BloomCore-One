import {
  BarChart3,
  Banknote,
  CreditCard,
  BookText,
  ClipboardList,
  Clock3,
  FileBarChart,
  FileSearch,
  Footprints,
  Handshake,
  Landmark,
  MessageSquareWarning,
  LayoutDashboard,
  MapPin,
  Plug,
  Scale,
  ScrollText,
  TrendingUp,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
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
    items: [
      { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/zeli", label: "Zeli Assistant", icon: Sparkles },
      {
        href: "/admin/zeli-analytics",
        label: "Zeli Business Intelligence",
        icon: BarChart3,
      },
    ],
  },
  {
    title: "MoMo",
    items: [
      { href: "/admin/locations", label: "Locations", icon: MapPin },
      { href: "/admin/workers", label: "Workers", icon: Users },
      { href: "/admin/ledger", label: "Transaction Ledger", icon: BookText },
      { href: "/admin/transfers", label: "Cash & Float", icon: Vault },
      { href: "/admin/liquidity", label: "Branch Liquidity", icon: Scale },
      { href: "/admin/reconciliation", label: "Reconciliation", icon: FileSearch },
      { href: "/admin/shifts", label: "Shifts & Handovers", icon: Clock3 },
      { href: "/admin/performance", label: "Performance", icon: TrendingUp },
      { href: "/admin/anomalies", label: "Anomaly Monitor", icon: ShieldAlert },
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
      { href: "/susu/admin/approvals", label: "Approvals", icon: ShieldCheck },
      { href: "/susu/admin/disputes", label: "Disputes", icon: MessageSquareWarning },
      { href: "/susu/admin/history", label: "Money & History", icon: BookText },
      { href: "/susu/admin/reports", label: "Reports", icon: FileBarChart },
    ],
  },
  {
    title: "Association",
    items: [
      { href: "/admin/association", label: "Membership & Training", icon: Handshake },
    ],
  },
  {
    title: "Administration",
    items: [
      { href: "/admin/billing", label: "Billing & Plan", icon: CreditCard },
      { href: "/admin/staff", label: "Staff", icon: UserCog },
      { href: "/admin/policy", label: "Operations Policy", icon: SlidersHorizontal },
      { href: "/admin/audit", label: "Activity History", icon: ScrollText },
      { href: "/admin/integrations", label: "Integrations", icon: Plug },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];
