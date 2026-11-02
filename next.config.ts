import type { NextConfig } from "next";

/**
 * Security headers for BIK Prestige Enterprise.
 *
 * CSP is kept in report-only mode initially to avoid breaking the
 * application.  Once validated, enforce via Content-Security-Policy.
 *
 * Note: Next.js inline scripts for hydration require 'unsafe-inline'
 * in script-src.  This is documented as an accepted exception.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com", // Next.js hydration + Turnstile
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
