import type { MetadataRoute } from "next";
import { IS_STAGING_DEPLOYMENT, absoluteUrl } from "@/lib/site";

/**
 * robots.txt.
 *
 * The public marketing pages are crawlable. Every authenticated application
 * route is disallowed, so tenant records, dashboards and sign-in pages stay
 * out of search indexes.
 *
 * The sitemap reference uses the same SITE_URL setting as the rest of the
 * public metadata, so it follows the domain when the owner confirms it.
 */
export default function robots(): MetadataRoute.Robots {
  if (IS_STAGING_DEPLOYMENT) {
    return {
      rules: [
        {
          userAgent: "*",
          disallow: "/",
        },
      ],
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/features", "/solutions", "/about", "/contact", "/privacy", "/terms"],
        disallow: [
          "/admin",
          "/api",
          "/collector",
          "/customer",
          "/platform",
          "/select-workspace",
          "/settings",
          "/susu",
          "/worker",
          "/access",
          "/change-password",
          "/forgot-password",
          "/login",
          "/reset-password",
        ],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
