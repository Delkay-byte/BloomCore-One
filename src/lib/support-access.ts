import { redirect } from "next/navigation";
import { getTenantContext, type TenantContext } from "@/lib/tenant";

/**
 * Phase 8 — support identity.
 *
 * Support sits under the Susu tab, but an administrator who signed in through
 * the private administrator login has no Susu tab cookie. Both sessions are
 * legitimate here: the Susu tab session for collectors and workers, and the
 * administrator session for business owners. The database row still decides the
 * role, and a request's tenant is still taken from this context, never from the
 * request body.
 */
export async function getSupportIdentity(): Promise<TenantContext | null> {
  const susu = await getTenantContext("susu", "susu");
  if (susu) return susu;
  const admin = await getTenantContext("admin", "susu");
  if (admin && admin.role === "admin") return admin;
  return null;
}

/** Page guard: the caller must have a live support identity. */
export async function requireSupportIdentity(): Promise<TenantContext> {
  const ctx = await getSupportIdentity();
  if (!ctx) redirect("/login?reason=tenant_unavailable");
  return ctx;
}
