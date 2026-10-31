"use client";

import { usePathname } from "next/navigation";
import { isPublicMarketingRoute } from "@/lib/public-routes";

function getEnvironmentLabel(): string | null {
  // Explicit APP_ENV takes priority (set in hosting environment)
  const appEnv = process.env.APP_ENV;
  if (appEnv) {
    // Only show recognized values; "production" means no badge
    const known = ["DEVELOPMENT", "STAGING", "PILOT", "TEST"];
    if (known.includes(appEnv.toUpperCase())) return appEnv.toUpperCase();
    if (appEnv === "production") return null;
  }

  // Fall back to NODE_ENV + DATABASE_URL detection
  const env = process.env.NODE_ENV;
  if (env === "production") {
    // In production, check DATABASE_URL to determine if PILOT
    const dbUrl = process.env.DATABASE_URL || "";
    if (dbUrl.includes("bik_pilot")) return "PILOT";
    // Production with no explicit APP_ENV and no pilot DB = no badge
    return null;
  }
  if (env === "test") return "TEST";

  // Non-production: check DATABASE_URL for environment hints
  const dbUrl = process.env.DATABASE_URL || "";
  if (dbUrl.includes("bik_pilot") || dbUrl.includes("5433")) return "PILOT";
  if (dbUrl.includes("bik_prestige") && dbUrl.includes("postgresql")) return "STAGING";
  return "DEVELOPMENT";
}

export default function EnvironmentBadge() {
  const pathname = usePathname();
  const label = getEnvironmentLabel();
  if (!label) return null;

  // The badge is an internal deployment marker. It never appears on the
  // public marketing site, where a visitor has no business seeing it.
  if (isPublicMarketingRoute(pathname)) return null;

  const colors: Record<string, string> = {
    DEVELOPMENT: "bg-yellow-100 text-yellow-800 border-yellow-300",
    STAGING: "bg-blue-100 text-blue-800 border-blue-300",
    PILOT: "bg-orange-100 text-orange-800 border-orange-300",
    TEST: "bg-gray-100 text-gray-600 border-gray-300",
  };

  return (
    <div
      className={`fixed bottom-3 right-3 z-[9999] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider border rounded ${colors[label] || colors.DEVELOPMENT}`}
      aria-label={`Environment: ${label}`}
    >
      {label}
    </div>
  );
}
