/**
 * Public access-link configuration for BloomCore One.
 *
 * This data structure is intentionally machine-readable so QR generation can
 * be added later. Each entry is a PUBLIC login URL — never credentials,
 * customer IDs, tokens, or recovery links. A QR code would encode only
 * `shortPath` (resolved against the site origin).
 */
export interface AccessLink {
  key: "customer" | "momo" | "susu" | "admin";
  title: string;
  icon: string;
  description: string;
  shortPath: string;
  instruction: string;
  /** Admin is the privileged account — keep it visually distinct. */
  admin?: boolean;
}

export const ACCESS_LINKS: AccessLink[] = [
  {
    key: "customer",
    title: "Customer",
    icon: "customer",
    description: "View your Susu savings and account",
    shortPath: "/login/customer",
    instruction: "Use your Customer ID, phone or email and password.",
  },
  {
    key: "momo",
    title: "MoMo Agent",
    icon: "momo",
    description: "Manage your daily MoMo transactions",
    shortPath: "/login/momo",
    instruction: "Use the staff login details provided by your administrator.",
  },
  {
    key: "susu",
    title: "Susu Collector",
    icon: "susu",
    description: "Manage customer savings collections",
    shortPath: "/login/susu",
    instruction: "Use the staff login details provided by your administrator.",
  },
  {
    key: "admin",
    title: "Administrator",
    icon: "🔐",
    description: "Manage your business workspace",
    shortPath: "/admin/login",
    instruction: "Use the separate administrator login.",
    admin: true,
  },
];
