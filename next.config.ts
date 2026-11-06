import type { NextConfig } from "next";

/**
 * Security headers for BIK Prestige Enterprise.
 *
 * The Content-Security-Policy is emitted by `src/middleware.ts` so each
 * dynamically rendered page receives a fresh nonce. Static configuration
 * cannot safely do that.
 */
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
