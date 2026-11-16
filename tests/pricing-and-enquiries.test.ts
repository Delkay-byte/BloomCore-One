import { existsSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isPublicMarketingRoute } from "@/lib/public-routes";
import {
  APPROVED_ANNUAL_PRICES,
  APPROVED_FOUNDING_PRICES,
  APPROVED_MONTHLY_PRICES,
  ENQUIRY_PACKAGES,
  FOUNDING_PROMOTION,
  annualSavingPercent,
  formatGhs,
  groupPlansForDisplay,
  type PublicPlan,
} from "@/lib/pricing/catalogue";
import { validateEnquiry } from "@/lib/pricing/enquiry";

/**
 * Public pricing discovery and the account-enquiry entry path.
 *
 * These tests cover the commercial presentation rules and the enquiry
 * validation. They do not touch payments: no charge is made anywhere here.
 */

const plan = (overrides: Partial<PublicPlan> = {}): PublicPlan => ({
  code: "zeli-monthly",
  name: "Business",
  description: "For growing businesses",
  billingInterval: "month",
  price: 169,
  currency: "GHS",
  features: ["MoMo operations", "Susu collections"],
  usageAllowance: null,
  locationLimit: 3,
  staffLimit: 10,
  supportLevel: "Standard support",
  ...overrides,
});

describe("approved commercial terms", () => {
  it("matches the owner-approved monthly prices", () => {
    expect(APPROVED_MONTHLY_PRICES).toEqual({ starter: 99, business: 169, "multi-branch": 339 });
  });

  it("matches the owner-approved founding prices and three-period rule", () => {
    expect(APPROVED_FOUNDING_PRICES).toEqual({ starter: 79, business: 149, "multi-branch": 225 });
    expect(FOUNDING_PROMOTION.maxBusinesses).toBe(5);
    expect(FOUNDING_PROMOTION.discountedPeriods).toBe(3);
    expect(FOUNDING_PROMOTION.annualEligible).toBe(false);
    expect(FOUNDING_PROMOTION.terms).toContain("first three monthly periods");
  });

  it("matches the owner-approved annual prices and stays near a 10% saving", () => {
    expect(APPROVED_ANNUAL_PRICES).toEqual({
      starter: 1070,
      business: 1825,
      "multi-branch": 3660,
    });
    expect(annualSavingPercent(99, 1070)).toBe(10);
    expect(annualSavingPercent(169, 1825)).toBe(10);
    expect(annualSavingPercent(339, 3660)).toBe(10);
  });

  it("rejects meaningless saving comparisons", () => {
    expect(annualSavingPercent(0, 100)).toBeNull();
    expect(annualSavingPercent(100, 1200)).toBeNull();
    expect(annualSavingPercent(100, 1500)).toBeNull();
  });
});

describe("public pricing presentation", () => {
  it("formats GHS amounts for Ghana", () => {
    expect(formatGhs(99)).toContain("99");
    expect(formatGhs(1070)).toContain("1,070");
  });

  it("splits monthly and annual plans", () => {
    const grouped = groupPlansForDisplay([
      plan(),
      plan({ code: "zeli-annual", billingInterval: "year", price: 1825 }),
    ]);
    expect(grouped.monthly).toHaveLength(1);
    expect(grouped.annual).toHaveLength(1);
  });

  it("shows location, staff and support limits only when configured", () => {
    const configured = plan();
    expect(configured.locationLimit).toBe(3);
    expect(configured.staffLimit).toBe(10);
    expect(configured.supportLevel).toBe("Standard support");
    expect(plan({ locationLimit: null, staffLimit: null, supportLevel: null }).locationLimit).toBeNull();
  });

  it("offers the approved packages in the enquiry form", () => {
    expect(ENQUIRY_PACKAGES).toEqual(["Starter", "Business", "Multi-Branch", "Not sure yet"]);
  });
});

describe("public route exposure", () => {
  it("makes /pricing public and keeps administrative routes private", () => {
    expect(isPublicMarketingRoute("/pricing")).toBe(true);
    expect(isPublicMarketingRoute("/pricing/yearly")).toBe(true);
    expect(isPublicMarketingRoute("/admin/login")).toBe(false);
    expect(isPublicMarketingRoute("/platform/login")).toBe(false);
    expect(isPublicMarketingRoute("/register")).toBe(false);
    expect(isPublicMarketingRoute("/admin/register")).toBe(false);
  });

  it("has no public self-registration route in the app tree", () => {
    const app = path.join(process.cwd(), "src", "app");
    for (const route of [
      "register",
      "signup",
      "sign-up",
      "(marketing)/register",
      "admin/register",
      "customer/register",
    ]) {
      expect(existsSync(path.join(app, route))).toBe(false);
    }
  });
});

describe("account enquiry validation", () => {
  const valid = {
    businessName: "Adom Ventures",
    contactName: "Ama Mensah",
    phone: "0551234987",
    email: "ama@adom.example",
    locationCount: "2",
    interestedPlan: "Business",
    message: "We run two MoMo points and Susu collections.",
  };

  it("accepts a complete enquiry and normalises it", () => {
    const result = validateEnquiry(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.businessName).toBe("Adom Ventures");
    expect(result.value.phone).toBe("0551234987");
    expect(result.value.locationCount).toBe(2);
    expect(result.value.email).toBe("ama@adom.example");
  });

  it("accepts an international-format Ghana number", () => {
    const result = validateEnquiry({ ...valid, phone: "+233551234987" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phone).toBe("0551234987");
  });

  it("allows the email, location count, package and message to be omitted", () => {
    const result = validateEnquiry({
      businessName: valid.businessName,
      contactName: valid.contactName,
      phone: valid.phone,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.email).toBeNull();
    expect(result.value.locationCount).toBeNull();
    expect(result.value.interestedPlan).toBeNull();
  });

  it("rejects a missing business name, contact or invalid phone", () => {
    expect(validateEnquiry({ ...valid, businessName: "" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, contactName: "A" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, phone: "12345" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, phone: "abc" }).ok).toBe(false);
  });

  it("rejects a malformed email but allows a blank one", () => {
    expect(validateEnquiry({ ...valid, email: "not-an-email" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, email: "" }).ok).toBe(true);
  });

  it("rejects out-of-range location counts and unknown packages", () => {
    expect(validateEnquiry({ ...valid, locationCount: "0" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, locationCount: "101" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, locationCount: "2.5" }).ok).toBe(false);
    expect(validateEnquiry({ ...valid, interestedPlan: "Enterprise" }).ok).toBe(false);
  });

  it("truncates oversized text instead of storing it", () => {
    const result = validateEnquiry({ ...valid, message: "x".repeat(5000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message?.length).toBe(2000);
  });
});
