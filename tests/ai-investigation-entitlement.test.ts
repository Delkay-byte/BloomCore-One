/**
 * AI Investigation package gate (owner-approved external processing).
 *
 * The owner approved external AI over real financial evidence, but only for a
 * business that has genuinely paid for the dedicated package and has been activated
 * by a Super Admin. These tests prove each refusal, prove that activation cannot be
 * reached from a tenant session, and prove that a revoked activation stops the very
 * next request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { setPlatformSession } from "@/lib/platform-auth";
import {
  AI_INVESTIGATION_ADDON,
  AI_INVESTIGATION_CODE_APPROVED,
  evaluateAiInvestigationAccess,
  resolveAiInvestigationAccess,
  type AiInvestigationInputs,
} from "@/lib/zeli/investigation/entitlement";
import {
  activateAiInvestigation,
  configureAiInvestigationPackage,
  getAiInvestigationAdminState,
  revokeAiInvestigation,
} from "@/lib/actions/ai-investigation-admin.actions";
import { generateInvestigationDraft, getInvestigationAi } from "@/lib/actions/zeli-investigation.actions";
import { runAnomalyScan } from "@/lib/actions/anomaly.actions";
import {
  externalProviderSettings,
  externalProviderPermittedForRuntime,
  requestExternalDraft,
} from "@/lib/zeli/investigation/provider";
import {
  externalGenerationBlockedReason,
  generateDraftForEvidence,
} from "@/lib/zeli/investigation/service";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function setTenantSession(user: { id: string; email: string }, role = "admin") {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Tenant Admin",
      role,
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

let platformCounter = 0;

async function setPlatformSessionAsSuperAdmin() {
  platformCounter += 1;
  const admin = await prisma.platformSuperAdmin.create({
    data: {
      email: `ai-operator-${platformCounter}-${Date.now()}@bloomcore.test`,
      fullName: "Platform Operator",
      passwordHash: "x",
      status: "active",
    },
  });
  await setPlatformSession({
    adminId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    tokenVersion: 0,
    lastActivityAt: Math.floor(Date.now() / 1000),
  });
  return admin;
}

function today(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset))
    .toISOString()
    .slice(0, 10);
}

const baseInputs = (): AiInvestigationInputs => {
  const now = new Date("2026-12-10T12:00:00Z");
  return {
    codeApproved: true,
    operatorDisabled: false,
    tenantStatus: "ACTIVE",
    role: "admin",
    plan: { code: "ai-investigation", name: "AI Investigation", addonKey: AI_INVESTIGATION_ADDON, usageAllowance: 25 },
    subscription: {
      status: "active",
      paidAt: new Date("2026-12-01T09:00:00Z"),
      periodEnd: new Date("2027-01-01T00:00:00Z"),
      amountConfirmed: true,
    },
    activation: { status: "active", expiresAt: new Date("2027-01-01T00:00:00Z") },
    usage: { requests: 3 },
    now,
  };
};

describe("entitlement decision matrix", () => {
  it("allows a paid, activated, in-period package with an unused allowance", () => {
    const decision = evaluateAiInvestigationAccess(baseInputs());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.state).toBe("active");
    expect(decision.remaining).toBe(22);
    expect(decision.activationStatus).toBe("active");
  });

  it("denies a free business with no package", () => {
    const decision = evaluateAiInvestigationAccess({ ...baseInputs(), plan: null, subscription: null, activation: null });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_package");
    expect(decision.guidance).toMatch(/has not been purchased/i);
  });

  it("denies a paid base subscription that is not the AI package", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      plan: { code: "growth", name: "Growth", addonKey: null, usageAllowance: null },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_package");
  });

  it("denies an AI package whose payment the provider never confirmed", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      subscription: { status: "pending", paidAt: null, periodEnd: null, amountConfirmed: false },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("payment_unconfirmed");
    expect(decision.state).toBe("payment_pending");
  });

  it("denies a paid package with no Super Admin activation", () => {
    const decision = evaluateAiInvestigationAccess({ ...baseInputs(), activation: null });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("activation_missing");
    expect(decision.state).toBe("not_activated");
    expect(decision.paymentConfirmed).toBe(true);
    expect(decision.guidance).toMatch(/Super Admin must activate/i);
  });

  it("denies an expired package period", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      subscription: {
        status: "active",
        paidAt: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-11-01T00:00:00Z"),
        amountConfirmed: true,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("payment_not_current");
    expect(decision.guidance).toMatch(/paid period .* has ended/i);
  });

  it("denies a revoked activation immediately", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      activation: { status: "revoked", expiresAt: new Date("2027-01-01T00:00:00Z") },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("activation_revoked");
    expect(decision.activationStatus).toBe("revoked");
  });

  it("denies an expired activation even when the payment is current", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      activation: { status: "active", expiresAt: new Date("2026-12-09T00:00:00Z") },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("activation_expired");
  });

  it("denies a used-up monthly allowance", () => {
    const decision = evaluateAiInvestigationAccess({ ...baseInputs(), usage: { requests: 25 } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("quota_exceeded");
    expect(decision.remaining).toBe(0);
  });

  it("applies a finite default budget to a package with no allowance configured", () => {
    const decision = evaluateAiInvestigationAccess({
      ...baseInputs(),
      plan: {
        code: "ai-investigation",
        name: "AI Investigation",
        addonKey: AI_INVESTIGATION_ADDON,
        usageAllowance: null,
      },
      usage: { requests: 49 },
    });
    // "Unset" must never read as "unlimited".
    expect(decision.allowance).toBe(50);
    expect(decision.remaining).toBe(1);
    expect(decision.allowed).toBe(true);
    expect(
      evaluateAiInvestigationAccess({ ...baseInputs(), plan: { code: "ai-investigation", name: "AI Investigation", addonKey: AI_INVESTIGATION_ADDON, usageAllowance: null }, usage: { requests: 50 } }).reason
    ).toBe("quota_exceeded");
  });

  it("denies a role that may not investigate", () => {
    for (const role of ["worker", "collector", "customer"]) {
      const decision = evaluateAiInvestigationAccess({ ...baseInputs(), role });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("role_not_permitted");
    }
  });

  it("denies an inactive business and an operator kill switch", () => {
    expect(
      evaluateAiInvestigationAccess({ ...baseInputs(), tenantStatus: "SUSPENDED" }).reason
    ).toBe("tenant_unavailable");
    expect(
      evaluateAiInvestigationAccess({ ...baseInputs(), operatorDisabled: true }).reason
    ).toBe("operator_disabled");
  });

  it("denies everything when the deployment approval is absent", () => {
    const decision = evaluateAiInvestigationAccess({ ...baseInputs(), codeApproved: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("approval_missing");
  });

  it("records that the narrow investigation approval exists", () => {
    expect(AI_INVESTIGATION_CODE_APPROVED).toBe(true);
  });
});

describe("Super Admin activation", () => {
  const originalDisabled = process.env.ZELI_INVESTIGATION_DISABLED;

  beforeEach(async () => {
    await cleanDatabase();
    mockCookieStore.clear();
    process.env.ZELI_INVESTIGATION_DISABLED = "";
  });

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.ZELI_INVESTIGATION_DISABLED;
    else process.env.ZELI_INVESTIGATION_DISABLED = originalDisabled;
  });

  async function businessWithFinding(paid = true) {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Gate Branch", code: `GATE-${Date.now().toString().slice(-6)}` },
    });
    const admin = await createTestAdmin({ tenantId: tenant.id, momo: true, susu: false });
    const worker = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `gate-worker-${Date.now()}@test.invalid`,
        fullName: "Gate Worker",
        role: "worker",
        status: "active",
        passwordHash: "x",
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await prisma.dailyAccount.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        workerId: worker.id,
        businessDate: new Date(`${today(1)}T00:00:00.000Z`),
        status: "submitted",
        submittedAt: new Date(),
        calculatedDifference: -120,
      },
    });
    await setTenantSession(admin);
    await runAnomalyScan({ from: today(10), to: today(0) });
    const finding = await prisma.operationalAnomaly.findFirstOrThrow({
      where: { tenantId: tenant.id, ruleKey: "daily_shortage" },
    });
    const { configureAiPackage, createAiSubscription } = await import("./ai-investigation-fixtures");
    await configureAiPackage();
    const subscription = await createAiSubscription(tenant.id, { paid });
    return { tenant, location, admin, worker, finding, subscription };
  }

  it("refuses activation from a tenant administrator session", async () => {
    const f = await businessWithFinding(true);
    // The tenant session is still active here; the platform action must not accept it.
    const result = await activateAiInvestigation({
      tenantId: f.tenant.id,
      reason: "Tenant administrator trying to enable the feature for itself.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not authenticated/i);
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: f.tenant.id } })
    ).toBe(0);
  });

  it("refuses a package whose payment was never confirmed", async () => {
    const f = await businessWithFinding(false);
    await setPlatformSessionAsSuperAdmin();
    const result = await activateAiInvestigation({
      tenantId: f.tenant.id,
      reason: "Activating after the provider was supposed to confirm payment.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no confirmed payment/i);
    expect(
      await prisma.aiInvestigationEntitlement.count({ where: { tenantId: f.tenant.id } })
    ).toBe(0);
  });

  it("activates a genuinely paid package and audits the actor, reason and plan", async () => {
    const f = await businessWithFinding(true);
    const platformAdmin = await setPlatformSessionAsSuperAdmin();

    const result = await activateAiInvestigation({
      tenantId: f.tenant.id,
      reason: "Payment verified in Paystack and the business requested the package.",
    });
    expect(result.success, result.error).toBe(true);

    const activation = await prisma.aiInvestigationEntitlement.findUniqueOrThrow({
      where: { tenantId: f.tenant.id },
    });
    expect(activation.status).toBe("active");
    expect(activation.planCode).toBe("ai-investigation");
    expect(activation.subscriptionId).toBe(f.subscription.id);
    expect(activation.activatedById).toBe(platformAdmin.id);
    expect(activation.reason).toMatch(/Payment verified/);

    const audit = await prisma.platformAuditLog.findFirstOrThrow({
      where: { tenantId: f.tenant.id, action: "ai_investigation.activated" },
    });
    const details = JSON.parse(String(audit.details));
    expect(audit.actorId).toBe(platformAdmin.id);
    expect(audit.reason).toMatch(/Payment verified/);
    expect(details.planCode).toBe("ai-investigation");
    expect(details.providerReference).toBe(f.subscription.providerReference);
    expect(details.financialMutation).toBe(false);

    // With both gates present, the feature works for the tenant administrator.
    await setTenantSession(f.admin);
    const generated = await generateInvestigationDraft(f.finding.id);
    expect(generated.success, generated.error).toBe(true);
  });

  it("revokes immediately and denies the next request", async () => {
    const f = await businessWithFinding(true);
    await setPlatformSessionAsSuperAdmin();
    await activateAiInvestigation({
      tenantId: f.tenant.id,
      reason: "Payment verified, activating the package for this business.",
    });

    await setTenantSession(f.admin);
    const before = await resolveAiInvestigationAccess(f.tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(before.allowed).toBe(true);

    await setPlatformSessionAsSuperAdmin();
    const revoked = await revokeAiInvestigation({
      tenantId: f.tenant.id,
      reason: "The business asked to withdraw the package and the payment was refunded.",
    });
    expect(revoked.success, revoked.error).toBe(true);

    await setTenantSession(f.admin);
    const after = await resolveAiInvestigationAccess(f.tenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(after.allowed).toBe(false);
    expect(after.reason).toBe("activation_revoked");

    const generated = await generateInvestigationDraft(f.finding.id);
    expect(generated.success).toBe(false);

    const audit = await prisma.platformAuditLog.findFirstOrThrow({
      where: { tenantId: f.tenant.id, action: "ai_investigation.revoked" },
    });
    expect(audit.reason).toMatch(/withdraw the package/);
  });

  it("enforces the monthly allowance and refuses to over-spend it", async () => {
    const f = await businessWithFinding(true);
    // A one-request package: the second generation must be refused.
    await prisma.zeliPlan.updateMany({
      where: { addonKey: AI_INVESTIGATION_ADDON },
      data: { usageAllowance: 1 },
    });
    await setPlatformSessionAsSuperAdmin();
    await activateAiInvestigation({
      tenantId: f.tenant.id,
      reason: "Payment verified for the one-request trial package.",
    });

    await setTenantSession(f.admin);
    const first = await generateInvestigationDraft(f.finding.id);
    expect(first.success, first.error).toBe(true);

    const second = await generateInvestigationDraft(f.finding.id);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/used its AI Investigation allowance/i);

    const usage = await prisma.aiInvestigationUsage.findFirstOrThrow({
      where: { tenantId: f.tenant.id },
    });
    expect(usage.requests).toBe(1);
    expect(usage.limit).toBe(1);
  });

  it("shows the platform the paid packages and what still has to happen", async () => {
    const f = await businessWithFinding(true);
    await setPlatformSessionAsSuperAdmin();
    const state = await getAiInvestigationAdminState();
    expect(state.success, state.error).toBe(true);
    const row = state.data!.businesses.find((item) => item.tenantId === f.tenant.id);
    expect(row?.paymentConfirmed).toBe(true);
    expect(row?.paymentCurrent).toBe(true);
    expect(row?.activationStatus).toBe("none");
    expect(row?.nextStep).toMatch(/A Super Admin may activate/i);
  });

  it("never invents a price for the package catalogue", async () => {
    await setPlatformSessionAsSuperAdmin();
    const zero = await configureAiInvestigationPackage({
      code: "ai-investigation",
      name: "AI Investigation",
      price: 0,
      billingInterval: "month",
      allowance: 25,
      status: "active",
      reason: "Trying to create the package without an approved price.",
    });
    expect(zero.success).toBe(false);
    expect(zero.error).toMatch(/cannot be zero/i);

    const configured = await configureAiInvestigationPackage({
      code: "ai-investigation",
      name: "AI Investigation",
      price: 150,
      billingInterval: "month",
      allowance: 25,
      status: "active",
      reason: "Platform approved the package price with the owner.",
    });
    expect(configured.success, configured.error).toBe(true);
    const plan = await prisma.zeliPlan.findUniqueOrThrow({ where: { code: "ai-investigation" } });
    expect(plan.addonKey).toBe(AI_INVESTIGATION_ADDON);
    expect(Number(plan.price)).toBe(150);
  });

  it("refuses a tenant administrator from reading the platform board", async () => {
    const f = await businessWithFinding(true);
    await setTenantSession(f.admin);
    const state = await getAiInvestigationAdminState();
    expect(state.success).toBe(false);
    expect(state.error).toMatch(/not authenticated/i);
  });

  it("keeps one business's activation out of another business", async () => {
    const a = await businessWithFinding(true);
    const bTenant = await createTestTenant({ momo: true, susu: false });
    const bAdmin = await createTestAdmin({ tenantId: bTenant.id, momo: true, susu: false });

    await setPlatformSessionAsSuperAdmin();
    await activateAiInvestigation({
      tenantId: a.tenant.id,
      reason: "Payment verified for business A only.",
    });

    await setTenantSession(bAdmin);
    const other = await resolveAiInvestigationAccess(bTenant.id, "admin", {
      operatorDisabled: false,
    });
    expect(other.allowed).toBe(false);
    expect(other.reason).toBe("no_package");

    const evidence = await getInvestigationAi(a.finding.id);
    expect(evidence.success).toBe(false);
    expect(evidence.error).toMatch(/not found/i);
  });
});

describe("provider safety", () => {
  function evidenceFixture() {
    return {
      version: "anomaly-evidence-v1",
      findingId: "finding-1",
      ruleKey: "daily_shortage",
      severity: "medium",
      status: "open",
      detectedAt: "2026-12-01T09:00:00.000Z",
      lastSeenAt: "2026-12-01T09:00:00.000Z",
      firstSeenAt: "2026-12-01T09:00:00.000Z",
      businessDate: "2026-11-30",
      metric: { measured: 120, threshold: 50, unit: "GHS" as const, calculation: "Closing variance vs threshold." },
      context: { branchLabel: "Branch", employeeLabel: "Role: worker", workerPseudonym: "Operator 4f2a" },
      sources: [
        {
          ref: "operational_anomaly:finding-1",
          type: "operational_anomaly" as const,
          label: "Finding",
          fields: { metricValue: 120, thresholdValue: 50 },
          hash: "a".repeat(64),
        },
      ],
      timeline: [],
      missingEvidence: [],
      limitations: ["This explanation only knows the records listed."],
      packHash: "b".repeat(64),
    };
  }

  it("never calls out from a test runtime", () => {
    expect(
      externalProviderPermittedForRuntime({ NODE_ENV: "test", DEEPSEEK_API_KEY: "x" } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      externalGenerationBlockedReason({ NODE_ENV: "test", DEEPSEEK_API_KEY: "x" } as NodeJS.ProcessEnv)
    ).toBe("test_runtime");
    expect(externalProviderSettings({} as NodeJS.ProcessEnv).configured).toBe(false);
    expect(
      externalGenerationBlockedReason({
        NODE_ENV: "production",
        DEEPSEEK_API_KEY: "",
      } as NodeJS.ProcessEnv)
    ).toBe("credential_missing");
  });

  it("falls back to the deterministic explanation on a provider timeout", async () => {
    const env = { NODE_ENV: "production", DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv;
    const result = await generateDraftForEvidence(evidenceFixture(), {
      allowExternal: true,
      env,
      fetchImpl: (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    expect(result.success, result.error).toBe(true);
    expect(result.data!.source).toBe("deterministic");
    expect(result.data!.fallbackReason).toBe("timeout");
    expect(result.data!.payload.modelMetadata.kind).toBe("deterministic");
  });

  it("rejects a provider answer that cites invented evidence and falls back", async () => {
    const env = { NODE_ENV: "production", DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv;
    const answer = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              findingId: "finding-1",
              schemaVersion: "anomaly-draft-v1",
              promptVersion: "anomaly-explanation-p1",
              facts: [
                {
                  sourceRef: "momo_transaction:invented",
                  text: "A transaction of GHS 120.00 was recorded on this day.",
                  values: [120],
                },
              ],
              hypotheses: [],
              missingEvidence: [],
              timeline: [],
              investigationQuestions: [],
              nextSteps: [],
              limitations: ["This explanation only knows the records listed."],
              modelMetadata: { kind: "external", model: "deepseek-chat", advisoryOnly: true },
            }),
          },
        },
      ],
    };
    const result = await generateDraftForEvidence(evidenceFixture(), {
      allowExternal: true,
      env,
      fetchImpl: (async () =>
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(result.success).toBe(true);
    expect(result.data!.source).toBe("deterministic");
    expect(["schema_rejected", "ungrounded"]).toContain(result.data!.fallbackReason);

    await expect(
      requestExternalDraft(evidenceFixture(), {
        env,
        fetchImpl: (async () =>
          new Response(JSON.stringify(answer), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: "schema_rejected" });
  });

  it("treats a rate-limited provider as a safe fallback", async () => {
    const env = { NODE_ENV: "production", DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv;
    const result = await generateDraftForEvidence(evidenceFixture(), {
      allowExternal: true,
      env,
      fetchImpl: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    });
    expect(result.success).toBe(true);
    expect(result.data!.source).toBe("deterministic");
    expect(result.data!.fallbackReason).toBe("rate_limited");
  });

  it("does not attempt an external call when the caller is not entitled", async () => {
    const env = { NODE_ENV: "production", DEEPSEEK_API_KEY: "test-key" } as NodeJS.ProcessEnv;
    let called = false;
    const result = await generateDraftForEvidence(evidenceFixture(), {
      allowExternal: false,
      env,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(result.data!.source).toBe("deterministic");
    expect(result.data!.fallbackReason).toBeNull();
  });
});
