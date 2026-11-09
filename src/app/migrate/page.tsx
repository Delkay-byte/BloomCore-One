import type { Metadata } from "next";
import { headers } from "next/headers";
import { getAdminSession, getMomoSession, getSusuSession } from "@/lib/auth";
import {
  CANONICAL_PRODUCTION_URL,
  isLegacyPublicHostname,
} from "@/lib/site";
import LegacyMigrationClient from "@/components/LegacyMigrationClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Move offline records",
  robots: { index: false, follow: false },
};

/**
 * Migration entry point for devices that still hold offline records on the
 * old Render origin. It is intentionally reachable on both origins so the
 * notice can link to it from either address.
 */
export default async function MigratePage() {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("host") ?? requestHeaders.get("x-forwarded-host");
  const legacyHost = isLegacyPublicHostname(host);
  const session =
    (await getAdminSession()) ??
    (await getMomoSession()) ??
    (await getSusuSession());

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-6 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          MaaCash address change
        </p>
        <h1 className="text-2xl font-semibold text-slate-900">
          Move this device&apos;s offline records
        </h1>
        <p className="text-sm text-slate-700">
          MaaCash now runs at{" "}
          <a className="underline underline-offset-2" href={CANONICAL_PRODUCTION_URL}>
            maacash.bloomcoretech.com
          </a>
          . Offline records are tied to the browser address that created them,
          so they must be synchronized from the old address before it is
          retired.
        </p>
      </header>

      <LegacyMigrationClient
        signedIn={Boolean(session)}
        legacyHost={legacyHost}
        canonicalUrl={CANONICAL_PRODUCTION_URL}
      />
    </main>
  );
}
