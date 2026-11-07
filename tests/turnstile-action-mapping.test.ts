/**
 * Turnstile action mapping regressions.
 *
 * The browser challenge action and the server-side expected action must agree
 * for every login surface. These tests exercise the real verification path,
 * including Cloudflare Siteverify response parsing, hostname checks, expiry and
 * the single-use token ledger. They do not mock action verification away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase } from "./setup";
import TurnstileWidget from "@/components/security/TurnstileWidget";
import {
  TURNSTILE_ACTIONS,
  activeTokenForAction,
  turnstileActionForRole,
} from "@/lib/security/turnstile-actions";
import {
  adminLogin,
  resolveCustomerAuth,
  resolveStaffAuth,
} from "@/lib/actions/auth.actions";

const PASS = "Test1234!";
const HOST = "bloomcore-one-staging.onrender.com";
const BASE = Date.now();
let tokenCounter = 0;

function configureTurnstile() {
  vi.stubEnv("TURNSTILE_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret-key");
  vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", HOST);
  vi.stubEnv("MFA_ENFORCEMENT", "optional");
}

function siteverify(action: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    hostname: HOST,
    action,
    challenge_ts: new Date(BASE).toISOString(),
    ...overrides,
  };
}

function stubSiteverify(action: string, overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(siteverify(action, overrides)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function freshToken(prefix: string) {
  tokenCounter += 1;
  return `${prefix}-${BASE}-${tokenCounter}`;
}

async function makeStaff() {
  return prisma.user.create({
    data: {
      email: "worker@bik.com",
      fullName: "Test Worker",
      role: "worker",
      status: "active",
      passwordHash: await bcrypt.hash(PASS, 4),
      momoEnabled: true,
      susuEnabled: false,
    },
  });
}

async function makeCustomer() {
  return prisma.customer.create({
    data: {
      customerId: "BIK-C-ACTION-1",
      fullName: "Test Customer",
      status: "active",
      portalEnabled: true,
      portalPasswordHash: await bcrypt.hash(PASS, 4),
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("TURNSTILE_ENABLED", "false");
  vi.stubEnv("MFA_ENFORCEMENT", "optional");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("login surface action mapping", () => {
  it("maps Customer to customer_login", () => {
    expect(turnstileActionForRole("customer")).toBe("customer_login");
    expect(turnstileActionForRole("customer")).toBe(TURNSTILE_ACTIONS.customerLogin);
  });

  it("maps MoMo Agent to login", () => {
    expect(turnstileActionForRole("momo")).toBe("login");
    expect(turnstileActionForRole("momo")).toBe(TURNSTILE_ACTIONS.staffLogin);
  });

  it("maps Susu Collector to login", () => {
    expect(turnstileActionForRole("susu")).toBe("login");
    expect(turnstileActionForRole("susu")).toBe(TURNSTILE_ACTIONS.staffLogin);
  });

  it("maps Administrator to admin_login", () => {
    expect(TURNSTILE_ACTIONS.adminLogin).toBe("admin_login");
  });

  it("renders the mapped action on the widget", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");

    for (const [role, expected] of [
      ["customer", "customer_login"],
      ["momo", "login"],
      ["susu", "login"],
    ] as const) {
      const html = renderToStaticMarkup(
        React.createElement(TurnstileWidget, {
          action: turnstileActionForRole(role),
        })
      );
      expect(html).toContain(`data-turnstile-action="${expected}"`);
    }

    const adminHtml = renderToStaticMarkup(
      React.createElement(TurnstileWidget, {
        action: TURNSTILE_ACTIONS.adminLogin,
      })
    );
    expect(adminHtml).toContain('data-turnstile-action="admin_login"');
  });
});

describe("stale challenge tokens", () => {
  it("clears a customer_login token when the role changes to MoMo", () => {
    const customerToken = "customer-token";
    // While Customer is selected the token is submitted.
    expect(
      activeTokenForAction(
        TURNSTILE_ACTIONS.customerLogin,
        customerToken,
        TURNSTILE_ACTIONS.customerLogin
      )
    ).toBe(customerToken);

    // After switching to MoMo the old token no longer belongs to the action.
    expect(
      activeTokenForAction(
        TURNSTILE_ACTIONS.customerLogin,
        customerToken,
        TURNSTILE_ACTIONS.staffLogin
      )
    ).toBe("");
  });

  it("only accepts a fresh customer_login token after switching back", () => {
    const staffToken = "staff-token";
    expect(
      activeTokenForAction(
        TURNSTILE_ACTIONS.staffLogin,
        staffToken,
        TURNSTILE_ACTIONS.customerLogin
      )
    ).toBe("");

    const freshCustomerToken = "fresh-customer-token";
    expect(
      activeTokenForAction(
        TURNSTILE_ACTIONS.customerLogin,
        freshCustomerToken,
        TURNSTILE_ACTIONS.customerLogin
      )
    ).toBe(freshCustomerToken);
  });
});

describe("server-side action enforcement", () => {
  it("rejects a staff login token submitted to customer authentication", async () => {
    const customer = await makeCustomer();
    configureTurnstile();
    stubSiteverify("login");

    const result = await resolveCustomerAuth(
      customer.customerId,
      PASS,
      freshToken("wrong-customer")
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Security verification failed");
    }
  });

  it("rejects a customer_login token submitted to staff authentication", async () => {
    const staff = await makeStaff();
    configureTurnstile();
    stubSiteverify("customer_login");

    const result = await resolveStaffAuth(
      staff.email,
      PASS,
      "momo",
      freshToken("wrong-staff")
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Security verification failed");
    }
  });

  it("accepts a matching customer_login token", async () => {
    const customer = await makeCustomer();
    configureTurnstile();
    const fetchMock = stubSiteverify("customer_login");

    const result = await resolveCustomerAuth(
      customer.customerId,
      PASS,
      freshToken("customer")
    );

    expect("payload" in result).toBe(true);
    if ("payload" in result) expect(result.payload.role).toBe("customer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a matching staff login token for MoMo", async () => {
    const staff = await makeStaff();
    configureTurnstile();
    stubSiteverify("login");

    const result = await resolveStaffAuth(
      staff.email,
      PASS,
      "momo",
      freshToken("staff")
    );

    expect("payload" in result).toBe(true);
    if ("payload" in result) expect(result.payload.role).toBe("worker");
  });

  it("uses admin_login on the administrator guard path", async () => {
    configureTurnstile();
    stubSiteverify("admin_login");

    const accepted = await adminLogin(
      (() => {
        const form = new FormData();
        form.set("email", "admin@bik.com");
        form.set("password", "wrong-password");
        form.set("turnstileToken", freshToken("admin-ok"));
        return form;
      })()
    );

    if (!accepted) throw new Error("expected an admin login response");
    expect(accepted.success).toBe(false);
    expect(accepted.error).not.toContain("Security verification failed");

    stubSiteverify("login");
    const rejected = await adminLogin(
      (() => {
        const form = new FormData();
        form.set("email", "admin@bik.com");
        form.set("password", "wrong-password");
        form.set("turnstileToken", freshToken("admin-bad"));
        return form;
      })()
    );

    if (!rejected) throw new Error("expected an admin login response");
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("Security verification failed");
  });

  it("still fails closed for expired, replayed, wrong-host and invalid tokens", async () => {
    configureTurnstile();

    const expiredToken = freshToken("expired");
    stubSiteverify("customer_login", {
      challenge_ts: new Date(BASE - 11 * 60 * 1000).toISOString(),
    });
    expect(await verify("customer_login", expiredToken)).toBe("expired");

    const replayToken = freshToken("replay");
    stubSiteverify("customer_login");
    expect(await verify("customer_login", replayToken)).toBe(null);
    expect(await verify("customer_login", replayToken)).toBe("replay");

    stubSiteverify("customer_login", { hostname: "attacker.example" });
    expect(await verify("customer_login", freshToken("host"))).toBe("hostname");

    stubSiteverify("customer_login", { success: false });
    expect(await verify("customer_login", freshToken("invalid"))).toBe("rejected");
  });
});

async function verify(action: string, token: string) {
  const { verifyTurnstile } = await import("@/lib/security/turnstile");
  const result = await verifyTurnstile({
    token,
    action,
    now: BASE,
  });
  return result.ok ? null : result.reason;
}
