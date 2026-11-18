import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { LEGAL_ROUTES, PLATFORM_LOGIN_PATH, PUBLIC_ROUTES } from "@/lib/site";

/**
 * Public website hygiene.
 *
 * The marketing site must read as a finished product: no platform
 * administration link, no internal draft/legal-review wording, and no
 * unreviewed terms document presented as the agreement.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const PUBLIC_FILES = [
  "src/components/marketing/MarketingFooter.tsx",
  "src/components/marketing/MarketingNav.tsx",
  "src/app/(marketing)/page.tsx",
  "src/app/(marketing)/pricing/page.tsx",
  "src/app/(marketing)/privacy/page.tsx",
  "src/app/(marketing)/terms/page.tsx",
  "src/app/(marketing)/contact/page.tsx",
  "src/app/(marketing)/about/page.tsx",
  "src/app/(marketing)/features/page.tsx",
  "src/app/(marketing)/solutions/page.tsx",
  "src/components/marketing/Sections.tsx",
];

const DRAFT_PHRASES = [
  /draft\s*[—-]\s*pending/i,
  /not (?:yet )?reviewed by (?:a )?lawyer/i,
  /do not treat this page as the final agreement/i,
  /no service level is promised/i,
  /must be reviewed before commercial launch/i,
  /will be updated before commercial launch/i,
  /not yet published; it will be added here/i,
  /is marked as a draft/i,
];

describe("public navigation", () => {
  it("never links to the platform administration login from the footer", () => {
    const footer = read("src/components/marketing/MarketingFooter.tsx");
    expect(footer).not.toContain(PLATFORM_LOGIN_PATH);
    expect(footer).not.toMatch(/platform administration/i);
  });

  it("never links to the platform login from public marketing routes", () => {
    for (const file of PUBLIC_FILES) {
      if (!existsSync(path.join(ROOT, file))) continue;
      expect(read(file), file).not.toContain(PLATFORM_LOGIN_PATH);
    }
  });

  it("keeps the platform login route available for operators", () => {
    expect(existsSync(path.join(ROOT, "src/app/platform/login/page.tsx"))).toBe(true);
    expect(existsSync(path.join(ROOT, "src/app/platform/login/PlatformLoginForm.tsx"))).toBe(true);
  });

  it("does not advertise administrator registration publicly", () => {
    const routes = PUBLIC_ROUTES.map((route) => route.path);
    expect(routes).not.toContain("/platform/login");
    expect(routes).not.toContain("/register");
    expect(routes).not.toContain("/signup");
  });

  it("publishes the privacy notice but not an unreviewed terms document", () => {
    const legal = LEGAL_ROUTES.map((route) => route.path);
    expect(legal).toContain("/privacy");
    expect(legal).not.toContain("/terms");
    const terms = read("src/app/(marketing)/terms/page.tsx");
    expect(terms).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});

describe("public copy", () => {
  it("contains no internal draft or legal-review wording", () => {
    const offenders: string[] = [];
    for (const file of PUBLIC_FILES) {
      if (!existsSync(path.join(ROOT, file))) continue;
      const source = read(file);
      for (const pattern of DRAFT_PHRASES) {
        if (pattern.test(source)) offenders.push(`${file} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not built from a draft-notice component any more", () => {
    const sections = read("src/components/marketing/Sections.tsx");
    expect(sections).not.toContain("DraftNotice");
  });

  it("describes the enquiry form and why its data is collected", () => {
    const privacy = read("src/app/(marketing)/privacy/page.tsx");
    expect(privacy).toMatch(/account enquiry form/i);
    expect(privacy).toMatch(/business\s+name/i);
    expect(privacy).toMatch(/Cloudflare Turnstile/i);
    expect(privacy).toMatch(/not sold|do not sell/i);
  });

  it("does not invent a public telephone or WhatsApp number", () => {
    for (const file of PUBLIC_FILES) {
      if (!existsSync(path.join(ROOT, file))) continue;
      const source = read(file);
      // Any literal Ghana phone number in public copy must come from config.
      expect(source, file).not.toMatch(/\+233\d{9}/);
    }
  });
});

describe("demonstration request page", () => {
  it("uses the public enquiry form and never gates it on contact configuration", () => {
    const contact = read("src/app/(marketing)/contact/page.tsx");
    expect(contact).toContain('variant="demo"');
    expect(contact).toMatch(/Request a MaaCash demonstration/i);
    // Optional contact details may appear, but never gate the form.
    expect(contact).not.toMatch(/CONTACT_CONFIGURED/);
    expect(contact).not.toMatch(/not published yet|submission route|configuration/i);
    // Customer-facing sign-in destinations.
    expect(contact).toContain("ADMIN_LOGIN_PATH");
    expect(contact).toContain("ALL_ACCESS_PATH");
  });

  it("points public sign-in links at the business owner login", async () => {
    const site = await import("@/lib/site");
    expect(site.BUSINESS_LOGIN_PATH).toBe("/admin/login");
    expect(site.ADMIN_LOGIN_PATH).toBe("/admin/login");
    expect(site.ALL_ACCESS_PATH).toBe("/access");
    expect(site.STAFF_LOGIN_PATH).toBe("/login");
    expect(site.CONTACT_CONFIGURED).toBe(false);
  });

  it("contains no development URLs in customer-facing sources", () => {
    for (const file of [
      ...PUBLIC_FILES,
      "src/components/marketing/PricingEnquiryForm.tsx",
      "src/lib/metadata.ts",
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/localhost/);
      expect(source, file).not.toMatch(/127\.0\.0\.1/);
      expect(source, file).not.toMatch(/:(3000|3100)\b/);
    }
  });

  it("builds public links from configuration, never a guessed host", async () => {
    const site = await import("@/lib/site");
    expect(site.absoluteUrl("/contact")).toBe(`${site.SITE_URL}/contact`);
    expect(site.SITE_URL).not.toMatch(/\/$/);
  });
});

describe("public origins", () => {
  it("treats loopback origins as provisional so localhost is never published", async () => {
    const { isLocalOrigin } = await import("@/lib/site");
    expect(isLocalOrigin("http://localhost:3100")).toBe(true);
    expect(isLocalOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalOrigin("https://maacash.bloomcoretech.com")).toBe(false);
  });

  it("emits no canonical or absolute localhost URLs while provisional", async () => {
    const { pageMetadata } = await import("@/lib/metadata");
    const site = await import("@/lib/site");
    const metadata = pageMetadata({
      path: "/contact",
      title: "Request a demonstration",
      description: "x",
    });
    expect(JSON.stringify(metadata)).not.toMatch(/localhost|127\.0\.0\.1/);
    if (site.SITE_URL_IS_PROVISIONAL) {
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.openGraph).not.toHaveProperty("url");
    } else {
      // Production keeps an absolute canonical on the public origin.
      expect(metadata.alternates?.canonical).toBe("/contact");
    }
  });
});
