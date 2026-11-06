/**
 * Production Content Security Policy.
 *
 * Scripts are nonce-based with `strict-dynamic`: Next.js applies the nonce to
 * its framework/page scripts (the root layout is dynamically rendered), and
 * scripts those chunks load at runtime — including the Turnstile widget — are
 * trusted transitively. No third-party origin is allowed to execute scripts
 * directly.
 *
 * `style-src` keeps `unsafe-inline` because Tailwind/React emit style
 * attributes. This is a much smaller risk than script injection.
 */
export function buildCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://challenges.cloudflare.com${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "connect-src 'self' https://challenges.cloudflare.com https://*.challenges.cloudflare.com data: blob:",
    "frame-src https://challenges.cloudflare.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}
