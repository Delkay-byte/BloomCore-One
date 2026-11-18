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
