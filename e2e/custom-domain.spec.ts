import { expect, test } from "@playwright/test";

/**
 * Read-only verification against the deployed public origins.
 *
 * These tests are opt-in so the normal suite never touches production:
 *   MAACASH_CANONICAL_ORIGIN=https://maacash.bloomcoretech.com
 *   MAACASH_LEGACY_ORIGIN=https://maacash.onrender.com
 */
const CANONICAL = process.env.MAACASH_CANONICAL_ORIGIN;
const LEGACY = process.env.MAACASH_LEGACY_ORIGIN;

test.describe("live canonical custom domain", () => {
  test.skip(!CANONICAL, "Set MAACASH_CANONICAL_ORIGIN to verify production.");

  test("serves canonical metadata and no Render host in public HTML", async ({
    request,
  }) => {
    const response = await request.get(`${CANONICAL}/`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<link rel="canonical" href="${CANONICAL}"/>`);
    expect(html).toContain(`content="${CANONICAL}/branding/maacash-og.png"`);
    expect(html).not.toContain("maacash.onrender.com");
    expect(html).not.toContain("bloomcore-one.onrender.com");
  });

  test("sitemap and robots use the canonical origin", async ({ request }) => {
    const sitemap = await request.get(`${CANONICAL}/sitemap.xml`);
    expect(sitemap.status()).toBe(200);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain(`<loc>${CANONICAL}/</loc>`);
    expect(sitemapBody).not.toContain("onrender.com");

    const robots = await request.get(`${CANONICAL}/robots.txt`);
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain(`Sitemap: ${CANONICAL}/sitemap.xml`);
  });

  test("manifest and service worker install on the custom origin", async ({
    page,
    request,
  }) => {
    await page.goto(`${CANONICAL}/`);

    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(manifestHref).toBe("/manifest.json");

    const manifestResponse = await request.get(`${CANONICAL}/manifest.json`);
    expect(manifestResponse.status()).toBe(200);
    const manifest = await manifestResponse.json();
    expect(manifest.id).toBe("/workspace");
    expect(manifest.start_url).toBe("/workspace");
    expect(manifest.scope).toBe("/");
    expect(manifest.icons.length).toBeGreaterThan(0);

    const worker = await request.get(`${CANONICAL}/tab-session-sw.js`);
    expect(worker.status()).toBe(200);
    expect(await worker.text()).toContain('self.addEventListener("fetch"');

    const registration = await page.evaluate(async () => {
      const registered = await navigator.serviceWorker.register(
        "/tab-session-sw.js",
        { scope: "/" }
      );
      await navigator.serviceWorker.ready;
      return { scope: registered.scope };
    });
    expect(registration.scope).toBe(`${CANONICAL}/`);

    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((item) => item.unregister()));
    });
  });

  test("health, readiness, routes and auth boundaries respond", async ({
    request,
  }) => {
    for (const route of [
      "/",
      "/login",
      "/admin/login",
      "/privacy",
      "/terms",
      "/features",
      "/solutions",
    ]) {
      const response = await request.get(`${CANONICAL}${route}`);
      expect(response.status(), route).toBe(200);
    }

    const health = await request.get(`${CANONICAL}/api/health`);
    expect(health.status()).toBe(200);
    expect((await health.json()).status).toBe("ok");

    const ready = await request.get(`${CANONICAL}/api/health/ready`);
    expect(ready.status()).toBe(200);
    expect((await ready.json()).status).toBe("ready");

    const protectedApi = await request.get(`${CANONICAL}/api/auth/me`);
    expect([401, 403]).toContain(protectedApi.status());

    const protectedPage = await request.get(`${CANONICAL}/admin/dashboard`, {
      maxRedirects: 0,
    });
    expect([302, 307, 308]).toContain(protectedPage.status());
    expect(protectedPage.headers()["location"]).toContain("/login");
  });
});

test.describe("live old-host transition", () => {
  test.skip(!LEGACY, "Set MAACASH_LEGACY_ORIGIN to verify the transition host.");

  test("stays reachable without a blanket redirect and shows the notice", async ({
    request,
  }) => {
    const response = await request.get(`${LEGACY}/`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["location"]).toBeUndefined();
    const html = await response.text();
    expect(html).toContain('data-maacash-legacy-host-notice="true"');
    expect(html).toContain("maacash.bloomcoretech.com");
    expect(html).toContain("synchronize any unsynchronized offline records");
  });

  test("keeps health and synchronization routes reachable", async ({
    request,
  }) => {
    const health = await request.get(`${LEGACY}/api/health`);
    expect(health.status()).toBe(200);
    expect((await health.json()).status).toBe("ok");

    const sync = await request.get(`${LEGACY}/api/offline/sync-contribution`, {
      maxRedirects: 0,
    });
    expect(sync.status()).not.toBe(404);
    expect([405, 401, 403, 400]).toContain(sync.status());
  });
});
