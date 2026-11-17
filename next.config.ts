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

/**
 * Webpack plugin that drops a module from the EDGE compilation only.
 *
 * `instrumentation.ts` starts a Node-only maintenance loop through a dynamic
 * import. Prisma 7's driver adapters (pg, better-sqlite3) use Node builtins that
 * do not exist in the edge runtime, and Next still walks the dynamic import
 * while compiling the middleware graph. The import is unreachable on edge
 * (it sits behind the `NEXT_RUNTIME !== "nodejs"` guard), so replacing it with
 * an ignored module is safe and keeps the edge bundle free of native drivers.
 */
function ignoreInEdgeOnly(resource: RegExp) {
  return {
    apply(compiler: {
      hooks: {
        normalModuleFactory: {
          tap: (name: string, handler: (nmf: NormalModuleFactoryLike) => void) => void;
        };
      };
    }) {
      compiler.hooks.normalModuleFactory.tap(
        "MaacashIgnoreEdgeModule",
        (nmf) => {
          nmf.hooks.beforeResolve.tap("MaacashIgnoreEdgeModule", (data) => {
            if (resource.test(data.request ?? "")) return false;
          });
        }
      );
    },
  };
}

interface NormalModuleFactoryLike {
  hooks: {
    beforeResolve: {
      tap: (
        name: string,
        handler: (data: { request?: string }) => boolean | void
      ) => void;
    };
  };
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  /**
   * Prisma 7 uses driver adapters. The PostgreSQL driver (node-postgres) and
   * its optional helpers, plus the SQLite native binding, must stay outside the
   * webpack bundle: they are server-only native/Node modules and resolving them
   * through the bundler breaks `path`/`stream` in the edge compilation of
   * instrumentation.ts.
   */
  webpack(config, { nextRuntime }) {
    if (nextRuntime === "edge") {
      config.plugins.push(
        ignoreInEdgeOnly(/(^|[\/])instrumentation-node$/) as never
      );
    }
    return config;
  },
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-pg",
    "@prisma/adapter-better-sqlite3",
    "pg",
    "pgpass",
    "better-sqlite3",
  ],
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
