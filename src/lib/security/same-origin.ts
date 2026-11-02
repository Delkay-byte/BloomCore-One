import { NextRequest } from "next/server";

/**
 * Same-origin enforcement for cookie-authenticated API mutations.
 *
 * Next.js server actions already validate Origin. API route handlers do not,
 * so every POST/PATCH/PUT/DELETE here must call this helper before acting.
 * Requests with no Origin header (older browsers, some native clients) are only
 * allowed when Fetch Metadata confirms a same-origin request.
 */

function configuredOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;

  if (origin) {
    if (origin === expected) return true;
    try {
      return configuredOrigins().includes(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";

  // No Origin and no Fetch Metadata: reject rather than guess.
  return false;
}

/** 403 response used consistently for rejected cross-origin mutations. */
export function crossOriginDenied(): Response {
  return Response.json(
    { success: false, error: "Request origin is not allowed" },
    { status: 403 }
  );
}
