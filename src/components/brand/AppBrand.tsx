import Link from "next/link";
import { BrandMark } from "@/components/brand/Brand";

/**
 * ============================================================================
 * APPLICATION BRAND BAR
 * ============================================================================
 *
 * Used by every authenticated screen that needs a product identity. Two rules
 * from the brand architecture apply here:
 *
 *   1. The SOFTWARE is "BloomCore One". It is never renamed per tenant.
 *   2. The BUSINESS is shown next to it, from the resolved tenant record, so
 *      BIK staff still see "BIK Prestige Enterprise" in their own workspace.
 *
 * The tenant name is passed in, never guessed, so a second business enrolled
 * later shows its own name automatically.
 */

export function AppBrand({
  tenantName,
  href = "/",
  tone = "light",
  markSize = 32,
  showTenant = true,
}: {
  /** Resolved tenant/business name, or null when it is not known on this screen. */
  tenantName?: string | null;
  href?: string;
  tone?: "light" | "dark";
  markSize?: number;
  showTenant?: boolean;
}) {
  const dark = tone === "dark";

  const identity = (
    <span className="flex min-w-0 flex-col leading-none">
      <span
        className={`font-semibold tracking-tight ${dark ? "text-white" : "text-ink-deep"}`}
        style={{ fontSize: Math.round(markSize * 0.58) }}
      >
        BloomCore
        <span className={dark ? "text-gold-400" : "text-gold-700"}> One</span>
      </span>
      {showTenant && tenantName ? (
        <span
          className={`mt-1 truncate text-[0.6875rem] font-medium ${
            dark ? "text-brand-200" : "text-ink-muted"
          }`}
          title={tenantName}
        >
          {tenantName}
        </span>
      ) : null}
    </span>
  );

  return (
    <Link
      href={href}
      className="inline-flex min-w-0 items-center gap-2.5 rounded-md"
      aria-label={
        tenantName ? `BloomCore One — ${tenantName}` : "BloomCore One home"
      }
    >
      <BrandMark size={markSize} tone={dark ? "onDark" : "tile"} />
      {identity}
    </Link>
  );
}
