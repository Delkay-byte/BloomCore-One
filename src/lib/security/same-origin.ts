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

function expectedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(request.url).origin);
  } catch {
    // Fall through to configured/proxy origins.
  }
  for (const value of [process.env.NEXTAUTH_URL, process.env.APP_URL]) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore malformed configuration; it cannot widen the allow-list.
    }
  }
  // Render terminates TLS at its proxy and forwards the public host/proto.
  // Only trust these headers when explicitly configured for a trusted proxy.
  if (process.env.TRUSTED_PROXY_HEADERS === "true") {
    const host = request.headers.get("x-forwarded-host");
    const proto = request.headers.get("x-forwarded-proto") || "https";
    if (host && /^[a-z0-9.:-]+$/i.test(host) && (proto === "https" || proto === "http")) {
      origins.add(`${proto}://${host}`);
    }
    const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (renderHost) origins.add(`https://${renderHost}`);
  }
  return origins;
}

export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const allowed = expectedOrigins(request);

  if (origin) {
    try {
      const normalized = new URL(origin).origin;
      if (allowed.has(normalized)) return true;
      return configuredOrigins().includes(normalized);
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
