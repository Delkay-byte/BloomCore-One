/**
 * Which authenticated module does the current workspace belong to?
 *
 * The answer is a *request routing hint*, never an authorization decision. It
 * tells the client which module session to ask the server about; the server
 * still verifies that module's tab credential before returning identity or a
 * tenant. A wrong or missing hint can only produce a denial, never access.
 *
 * This exists because a dual-role account has one primary User.role but two
 * module sessions. Deriving the workspace from the primary role is wrong: a
 * worker-role collector working in the Susu tab must resolve the Susu session.
 */

import type { ModuleName } from "@/lib/auth";

export function moduleForPath(
  pathname: string | null | undefined
): ModuleName | null {
  if (!pathname) return null;
  if (pathname.startsWith("/collector")) return "susu";
  if (pathname.startsWith("/worker")) return "momo";
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/customer")) return "customer";
  return null;
}

/** Module of the workspace open in this browser tab, if it has one. */
export function activeWorkspaceModule(): ModuleName | null {
  if (typeof window === "undefined") return null;
  return moduleForPath(window.location.pathname);
}

export function isOfflineModule(
  module: ModuleName | null | undefined
): module is "momo" | "susu" {
  return module === "momo" || module === "susu";
}
