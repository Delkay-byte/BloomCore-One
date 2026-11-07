import type { MetadataRoute } from "next";
import {
  IS_STAGING_DEPLOYMENT,
  LEGAL_ROUTES,
  PUBLIC_ROUTES,
  absoluteUrl,
} from "@/lib/site";

/**
 * Public sitemap.
 *
 * Only public marketing pages are listed. Authenticated application routes are
 * never included — they are per-tenant and must not be indexed.
 *
 * The host comes from SITE_URL (see src/lib/site.ts). While that setting
 * still points at the temporary hosting address, the sitemap advertises that
 * address, which is where the site actually lives. Set SITE_URL (or
 * NEXT_PUBLIC_SITE_URL) when the real domain is confirmed and every URL here
 * follows automatically.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  // Staging is not a public property and must not advertise its URLs to
  // crawlers. The production sitemap is unchanged.
  if (IS_STAGING_DEPLOYMENT) return [];

  const routes = [
    ...PUBLIC_ROUTES.map((route) => ({
      url: absoluteUrl(route.path),
      changeFrequency: "weekly" as const,
      priority: route.path === "/" ? 1 : 0.8,
    })),
    ...LEGAL_ROUTES.map((route) => ({
      url: absoluteUrl(route.path),
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];

  return routes.map((route) => ({
    ...route,
    lastModified: new Date(),
  }));
}
