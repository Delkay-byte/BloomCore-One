"use server";

import { cookies } from "next/headers";
import {
  SSO_HANDOFF_COOKIE,
  SSO_HANDOFF_DESTINATION_COOKIE,
} from "@/lib/security/sso-handoff";

export interface SsoClaimResult {
  success: boolean;
  error?: string;
  sessionToken?: string;
  redirectTo?: string;
}

/**
 * Consume the one-time SSO handoff and return the tab session handle.
 * The cookie is deleted before the result leaves the server, so a replay sees
 * nothing even if another tab races the same URL.
 */
export async function claimSsoSession(): Promise<SsoClaimResult> {
  const store = await cookies();
  const token = store.get(SSO_HANDOFF_COOKIE)?.value;
  const destination =
    store.get(SSO_HANDOFF_DESTINATION_COOKIE)?.value || "/platform/dashboard";
  store.delete({ name: SSO_HANDOFF_COOKIE, path: "/platform/login/sso" });
  store.delete({
    name: SSO_HANDOFF_DESTINATION_COOKIE,
    path: "/platform/login/sso",
  });
  if (!token) {
    return { success: false, error: "Single sign-on session expired. Please sign in again." };
  }
  return {
    success: true,
    sessionToken: token,
    redirectTo: destination.startsWith("/platform/")
      ? destination
      : "/platform/dashboard",
  };
}
