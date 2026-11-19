import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

function normalized(relative: string): string {
  return source(relative).replace(/\s+/g, " ");
}

const CUSTOMER_PAYMENT_FILES = [
  "src/app/admin/(workspace)/billing/BillingClient.tsx",
  "src/app/admin/(workspace)/zeli-analytics/upgrade/CheckoutPlans.tsx",
  "src/app/checkout/return/page.tsx",
];

const NEUTRAL =
  "Payments are processed securely by Paystack. Your subscription will be activated once your payment has been successfully verified. You will see the applicable amount before confirming your payment.";

describe("customer payment messaging", () => {
  it("uses the approved neutral explanation on billing and package checkout", () => {
    expect(normalized(CUSTOMER_PAYMENT_FILES[0])).toContain(NEUTRAL);
    expect(normalized(CUSTOMER_PAYMENT_FILES[1])).toContain(NEUTRAL);
    expect(normalized(CUSTOMER_PAYMENT_FILES[2])).toContain(
      "Payments are processed securely by Paystack"
    );
  });

  it("never renders key mode, local-test guards or workspace allowlists", () => {
    for (const file of CUSTOMER_PAYMENT_FILES) {
      const text = source(file);
      expect(text).not.toMatch(/liveReadiness|providerMode|localLiveTest/);
      expect(text).not.toMatch(/local[- ]live|test key|live key|allowlist|safeguard/i);
      expect(text).not.toContain("PAYSTACK_LOCAL_LIVE");
    }
  });

  it("keeps useful status and failure feedback", () => {
    const billing = source(CUSTOMER_PAYMENT_FILES[0]);
    expect(billing).toContain("Check payment status");
    expect(billing).toContain("Do not pay again");
    expect(billing).toContain("No money was taken");
    const returned = source(CUSTOMER_PAYMENT_FILES[2]);
    expect(returned).toContain("Payment confirmed");
    expect(returned).toContain("Payment not confirmed yet");
  });
});
