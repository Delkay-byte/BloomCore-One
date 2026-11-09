import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const CANONICAL = "https://maacash.bloomcoretech.com";
const OLD_PRIMARY = "https://maacash.onrender.com";
const OLD_FALLBACK = "https://bloomcore-one.onrender.com";

function resetModules() {
  vi.resetModules();
}

function configureRender(siteUrl = "") {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("RENDER", "true");
  vi.stubEnv("RENDER_SERVICE_ID", "srv-test");
  vi.stubEnv("SITE_URL", siteUrl);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  resetModules();
}

function configureLocal() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ENV", "");
  vi.stubEnv("RENDER", "");
  vi.stubEnv("RENDER_SERVICE_ID", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  resetModules();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("canonical production origin", () => {
  it("is the configured custom domain in production", async () => {
    configureRender(CANONICAL);
    const site = await import("@/lib/site");
    expect(site.SITE_URL).toBe(CANONICAL);
    expect(site.SITE_URL_IS_PROVISIONAL).toBe(false);
  });

  it("falls back to the custom domain on Render when no env value is set", async () => {
    configureRender();
    const site = await import("@/lib/site");
    expect(site.SITE_URL).toBe(CANONICAL);
    expect(site.SITE_URL_IS_PROVISIONAL).toBe(false);
  });

  it("stays local outside a Render deployment and never claims canonical status", async () => {
    configureLocal();
    const site = await import("@/lib/site");
    expect(site.SITE_URL).toBe("http://localhost:3000");
    expect(site.SITE_URL_IS_PROVISIONAL).toBe(true);
  });

  it("keeps the dedicated staging origin when staging supplies it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "STAGING");
    vi.stubEnv("RENDER", "true");
    vi.stubEnv("SITE_URL", "https://bloomcore-one-staging.onrender.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    resetModules();

    const site = await import("@/lib/site");
    expect(site.SITE_URL).toBe("https://bloomcore-one-staging.onrender.com");
    expect(site.IS_STAGING_DEPLOYMENT).toBe(true);
  });
});

describe("public metadata and crawler files", () => {
  it("emits canonical, Open Graph and Twitter URLs on the custom domain", async () => {
    configureRender(CANONICAL);
    const { pageMetadata } = await import("@/lib/metadata");
    const metadata = pageMetadata({
      path: "/features",
      title: "Features",
      description: "Feature overview",
    });

    expect(metadata.alternates).toEqual({ canonical: "/features" });
    expect(metadata.openGraph?.url).toBe("/features");
    expect(metadata.openGraph?.images).toEqual([
      expect.objectContaining({ url: `${CANONICAL}/branding/maacash-og.png` }),
    ]);
    expect(metadata.twitter?.images).toEqual([
      `${CANONICAL}/branding/maacash-og.png`,
    ]);
  });

  it("builds absolute URLs from the canonical origin", async () => {
    configureRender(CANONICAL);
    const { absoluteUrl } = await import("@/lib/site");
    expect(absoluteUrl("/sitemap.xml")).toBe(`${CANONICAL}/sitemap.xml`);
    expect(absoluteUrl("login")).toBe(`${CANONICAL}/login`);
  });

  it("writes the custom domain into sitemap.xml and robots.txt", async () => {
    configureRender(CANONICAL);
    const robots = (await import("@/app/robots")).default();
    expect(robots.sitemap).toBe(`${CANONICAL}/sitemap.xml`);

    const sitemap = (await import("@/app/sitemap")).default();
    expect(sitemap.length).toBeGreaterThan(0);
    expect(
      sitemap.every((entry) => entry.url.startsWith(`${CANONICAL}/`))
    ).toBe(true);
    expect(sitemap.some((entry) => entry.url.includes("onrender.com"))).toBe(
      false
    );
  });

  it("does not emit a canonical URL on local development", async () => {
    configureLocal();
    const { pageMetadata } = await import("@/lib/metadata");
    const metadata = pageMetadata({
      path: "/features",
      title: "Features",
      description: "Feature overview",
    });
    expect(metadata.alternates).toBeUndefined();
  });
});

describe("old-host transition", () => {
  it("recognises both retired Render hostnames and rejects other hosts", async () => {
    configureRender(CANONICAL);
    const site = await import("@/lib/site");

    expect(site.isLegacyPublicHostname("maacash.onrender.com")).toBe(true);
    expect(site.isLegacyPublicHostname("MAACASH.ONRENDER.COM:443")).toBe(true);
    expect(site.isLegacyPublicHostname("bloomcore-one.onrender.com")).toBe(true);
    expect(site.isLegacyPublicHostname("maacash.bloomcoretech.com")).toBe(false);
    expect(site.isLegacyPublicHostname("evil.example.com")).toBe(false);
    expect(site.isLegacyPublicHostname(null)).toBe(false);
  });

  it("shows the migration notice only on the old Render hosts", async () => {
    configureRender(CANONICAL);
    const site = await import("@/lib/site");

    expect(site.shouldShowLegacyHostNotice("maacash.onrender.com")).toBe(true);
    expect(site.shouldShowLegacyHostNotice("bloomcore-one.onrender.com")).toBe(
      true
    );
    expect(site.shouldShowLegacyHostNotice("maacash.bloomcoretech.com")).toBe(
      false
    );
  });

  it("keeps the notice out of staging", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "STAGING");
    vi.stubEnv("RENDER", "true");
    vi.stubEnv("SITE_URL", "https://bloomcore-one-staging.onrender.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    resetModules();

    const site = await import("@/lib/site");
    expect(site.shouldShowLegacyHostNotice("maacash.onrender.com")).toBe(false);
  });

  it("wires the notice into the root layout without a redirect", async () => {
    const layout = readFileSync(
      path.join(process.cwd(), "src/app/layout.tsx"),
      "utf8"
    );
    const notice = readFileSync(
      path.join(process.cwd(), "src/components/LegacyHostNotice.tsx"),
      "utf8"
    );
    expect(layout).toContain("shouldShowLegacyHostNotice");
    expect(layout).toContain("<LegacyHostNotice />");
    expect(notice).toContain("synchronize any unsynchronized offline records");
    expect(notice).toContain("prepare the device for offline use");
    expect(notice).not.toContain('http-equiv="refresh"');
  });
});

describe("trusted origins", () => {
  it("accepts the custom domain and old same-origin hosts but rejects others", async () => {
    vi.stubEnv("NEXTAUTH_URL", CANONICAL);
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("ALLOWED_ORIGINS", "");
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "");
    resetModules();

    const { isSameOriginRequest } = await import("@/lib/security/same-origin");

    const canonical = new NextRequest(`${CANONICAL}/api/auth/logout`, {
      method: "POST",
      headers: { origin: CANONICAL },
    });
    expect(isSameOriginRequest(canonical)).toBe(true);

    const oldHost = new NextRequest(`${OLD_PRIMARY}/api/auth/logout`, {
      method: "POST",
      headers: { origin: OLD_PRIMARY },
    });
    expect(isSameOriginRequest(oldHost)).toBe(true);

    const fallbackHost = new NextRequest(`${OLD_FALLBACK}/api/auth/logout`, {
      method: "POST",
      headers: { origin: OLD_FALLBACK },
    });
    expect(isSameOriginRequest(fallbackHost)).toBe(true);

    const evil = new NextRequest(`${CANONICAL}/api/auth/logout`, {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(isSameOriginRequest(evil)).toBe(false);
  });
});

describe("repository production configuration", () => {
  it("sets the canonical origin in the Render blueprint", () => {
    const yaml = readFileSync(path.join(process.cwd(), "render.yaml"), "utf8");
    expect(yaml).toMatch(
      /key: SITE_URL\r?\n\s+value: "https:\/\/maacash\.bloomcoretech\.com"/
    );
    expect(yaml).toMatch(
      /key: NEXT_PUBLIC_SITE_URL\r?\n\s+value: "https:\/\/maacash\.bloomcoretech\.com"/
    );
    expect(yaml).toMatch(
      /key: NEXTAUTH_URL\r?\n\s+value: "https:\/\/maacash\.bloomcoretech\.com"/
    );
    expect(yaml).toContain(
      "maacash.bloomcoretech.com,maacash.onrender.com,bloomcore-one.onrender.com"
    );
  });

  it("keeps staging on its own base URL", () => {
    const yaml = readFileSync(
      path.join(process.cwd(), "render.staging.yaml"),
      "utf8"
    );
    expect(yaml).toContain("https://bloomcore-one-staging.onrender.com");
    expect(yaml).not.toContain("maacash.bloomcoretech.com");
  });
});
