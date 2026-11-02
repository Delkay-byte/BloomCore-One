import type { NextConfig } from "next";

/**
 * Security headers for BIK Prestige Enterprise.
 *
 * CSP is enforced. `script-src` keeps `'unsafe-inline'` because the App Router
 * hydrates through inline bootstrap scripts; moving to a nonce requires every
 * page (including the statically generated marketing pages) to become
 * dynamically rendered. That trade-off is documented in
 * docs/security/CSP-ASSESSMENT.md and is deliberately not taken here.
 *
 * `'unsafe-eval'` is development-only: React needs it for enhanced debugging,
 * while production React/Next.js do not use `eval`.
 */
const isDev = process.env.NODE_ENV === "development";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com`, // Next.js hydration + Turnstile
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // Tailwind + Google Fonts
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self' https://challenges.cloudflare.com https://*.challenges.cloudflare.com data: blob:",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: csp,
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
  {
    key: "X-Permitted-Cross-Domain-Policies",
    value: "none",
  },
];

/**
 * Headers applied to sensitive authenticated pages.
 * Prevents browser caching of protected content.
 */
const sensitiveHeaders = [
  {
    key: "Cache-Control",
    value: "no-store, no-cache, must-revalidate, proxy-revalidate",
  },
  {
    key: "Pragma",
    value: "no-cache",
  },
  {
    key: "Expires",
    value: "0",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      // Protected pages: no browser caching
      {
        source: "/(admin|worker|collector|platform|settings|change-password|mfa)/:path*",
        headers: sensitiveHeaders,
      },
      // API routes: no caching of authenticated responses
      {
        source: "/api/(auth|user|audit|admin)/:path*",
        headers: sensitiveHeaders,
      },
    ];
  },
};

export default nextConfig;
