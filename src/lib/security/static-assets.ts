/**
 * Static-asset classification for the middleware.
 *
 * The middleware previously skipped authentication whenever the pathname
 * contained a dot, so `/admin/staff/foo.bar` and `/admin/reports/2026.11.15`
 * were treated as public. Exemptions must be a closed list now: a path is only
 * static when it lives under Next.js internals or ends in a known static
 * extension.
 */

export const STATIC_FILE_EXTENSIONS: readonly string[] = [
  ".css",
  ".js",
  ".mjs",
  ".map",
  ".json",
  ".txt",
  ".xml",
  ".webmanifest",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".pdf",
];

const STATIC_DIRECTORIES: readonly string[] = [
  "/_next/static/",
  "/_next/image",
  "/branding/",
  "/assets/",
  "/images/",
  "/icons/",
];

/** True only for genuine framework assets and known static file types. */
export function isStaticAssetPath(pathname: string): boolean {
  const path = (pathname ?? "").toLowerCase();
  if (!path.startsWith("/")) return false;
  if (path === "/favicon.ico" || path === "/robots.txt" || path === "/sitemap.xml") {
    return true;
  }
  if (
    STATIC_DIRECTORIES.some((dir) => {
      const withSlash = dir.endsWith("/") ? dir : `${dir}/`;
      return path === withSlash.slice(0, -1) || path.startsWith(withSlash);
    })
  ) {
    return true;
  }
  // SEC-09: outside the approved asset directories only a root-level file may
  // be static. A protected dynamic route such as /admin/staff/report.json must
  // never inherit the middleware bypass from its extension.
  const relative = path.slice(1);
  if (relative.includes("/")) return false;
  const lastDot = relative.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const extension = relative.slice(lastDot);
  return STATIC_FILE_EXTENSIONS.includes(extension);
}
