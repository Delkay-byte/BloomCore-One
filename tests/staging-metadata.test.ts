import { afterEach, describe, expect, it, vi } from "vitest";

const STAGING_URL = "https://bloomcore-one-staging.onrender.com";
const PRODUCTION_URL = "https://maacash.bloomcoretech.com";

function configure(appEnv: string, siteUrl: string) {
  vi.stubEnv("APP_ENV", appEnv);
  vi.stubEnv("SITE_URL", siteUrl);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("staging metadata", () => {
  it("uses the staging host for Open Graph and Twitter images", async () => {
    configure("STAGING", STAGING_URL);
    const { pageMetadata } = await import("@/lib/metadata");
    const metadata = pageMetadata({
      path: "/features",
      title: "Features",
      description: "Feature overview",
    });

    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: `${STAGING_URL}/branding/maacash-og.png` }),
    ]);
    expect(metadata.twitter?.images).toEqual([
      `${STAGING_URL}/branding/maacash-og.png`,
    ]);
  });

  it("does not emit a canonical URL on staging", async () => {
    configure("STAGING", STAGING_URL);
    const { pageMetadata } = await import("@/lib/metadata");
    const metadata = pageMetadata({
      path: "/",
      title: "MaaCash",
      description: "Description",
      absolute: true,
    });

    expect(metadata.alternates).toBeUndefined();
  });

  it("marks staging noindex, nofollow", async () => {
    configure("STAGING", STAGING_URL);
    const { rootRobotsMetadata } = await import("@/lib/metadata");
    expect(rootRobotsMetadata()).toEqual({ index: false, follow: false });
  });

  it("disallows all crawling and omits the sitemap on staging", async () => {
    configure("STAGING", STAGING_URL);
    const robots = (await import("@/app/robots")).default();
    expect(robots.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
    expect(robots.sitemap).toBeUndefined();
  });

  it("returns an empty sitemap on staging", async () => {
    configure("STAGING", STAGING_URL);
    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap).toEqual([]);
  });
});

describe("production metadata is unchanged", () => {
  it("keeps production social URLs and canonical URLs", async () => {
    configure("production", PRODUCTION_URL);
    const { pageMetadata, rootRobotsMetadata } = await import("@/lib/metadata");
    const metadata = pageMetadata({
      path: "/features",
      title: "Features",
      description: "Feature overview",
    });

    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({
        url: `${PRODUCTION_URL}/branding/maacash-og.png`,
      }),
    ]);
    expect(metadata.alternates).toEqual({ canonical: "/features" });
    expect(rootRobotsMetadata()).toBeUndefined();
  });

  it("keeps the production robots.txt and sitemap", async () => {
    configure("production", PRODUCTION_URL);
    const robots = (await import("@/app/robots")).default();
    expect(robots.sitemap).toBe(`${PRODUCTION_URL}/sitemap.xml`);
    expect(robots.rules).not.toEqual([{ userAgent: "*", disallow: "/" }]);

    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap.length).toBeGreaterThan(0);
    expect(sitemap.every((entry) => entry.url.startsWith(PRODUCTION_URL))).toBe(true);
  });
});
