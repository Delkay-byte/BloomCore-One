/**
 * Session issuance internals.
 *
 * These helpers are deliberately NOT in a `"use server"` module. Every exported
 * async function in a `"use server"` module becomes a publicly callable server
 * action RPC endpoint, so a helper such as `issueModuleSession` must never live
 * there: it takes a caller-supplied user id, module and MFA flag and returns a
 * valid session. Only server code that has already authenticated the caller may
 * import this module.
 */

import { db } from "@/lib/db";
import {
  setModuleSession,
  type JwtPayload,
  type ModuleName,
} from "@/lib/auth";

export async function buildSessionPayload(userId: string): Promise<JwtPayload> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const modules: ("momo" | "susu")[] = [];
  if (user.momoEnabled) modules.push("momo");
  if (user.susuEnabled) modules.push("susu");
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role as "admin" | "worker" | "collector",
    modules,
    locationId: user.locationId ?? undefined,
    tenantId: user.tenantId,
    forcePasswordReset: user.forcePasswordReset,
    tokenVersion: user.tokenVersion,
  };
}

/**
 * Issue a fresh session for `userId` for the given module.
 * Returns the token so the calling tab can register it with its worker.
 *
 * Callers must have proven the caller's identity first. This function performs
 * no authentication or authorization of its own.
 */
export async function issueModuleSession(
  userId: string,
  module: ModuleName,
  mfaVerified = false
): Promise<{ payload: JwtPayload; token: string }> {
  const payload = await buildSessionPayload(userId);
  const withAmr: JwtPayload = {
    ...payload,
    module,
    amr: mfaVerified ? "pwd+mfa" : "pwd",
  };
  const token = await setModuleSession(module, withAmr);
  return { payload: withAmr, token };
}
