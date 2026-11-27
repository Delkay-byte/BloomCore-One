/**
 * Phase 4 — enterprise withdrawal controls.
 * Direct server-action tests with synthetic multi-admin, multi-tenant fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: {
    current: null as null | Record<string, unknown>,
    queue: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.queue.shift() ?? ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.queue.shift() ?? ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.queue.shift() ?? ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.queue.shift() ?? ctxHolder.current,
}));

import {
  approveWithdrawalRequest,
  getHighValueWithdrawalQueue,
  getWithdrawalPolicy,
  payWithdrawalRequest,
  saveWithdrawalPolicy,
} from "@/lib/actions/withdrawal-control.actions";
import { requestWithdrawal } from "@/lib/actions/withdrawal-request.actions";
import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import {
  hashStepUpToken,
  stepUpContextHash,
  type StepUpPurpose,
} from "@/lib/security/step-up";

let tenantId: string;
let branchA: string;
let adminA: { id: string; email: string };
let adminB: { id: string; email: string };
let customerId: string;
let accountId: string;
let cycleId: string;

function adminCtx(user: { id: string; email: string }): Record<string, unknown> {
  return {
    tenantId,
    tenantName: "Phase 4 Tenant",
    tenantCode: "P4",
    userId: user.id,
    email: user.email,
    role: "admin",
    modules: ["susu"],
  };
}

function asAdmin(user: { id: string; email: string }) {
  ctxHolder.current = adminCtx(user);
}

function asCustomer() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Phase 4 Tenant",
    tenantCode: "P4",
    userId: customerId,
    role: "customer",
    modules: ["susu"],
  };
}

async function createAdmin(email: string, fullName: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email,
      fullName,
      role: "admin",
      status: "active",
      passwordHash: "synthetic",
      susuEnabled: true,
    },
  });
}

async function grant(input: {
  purpose: StepUpPurpose;
  subjectId: string;
  targetType: string;
  targetId: string;
  context: Record<string, unknown>;
}): Promise<string> {
  const raw = `p4-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await prisma.stepUpGrant.create({
    data: {
      tokenHash: hashStepUpToken(raw),
      subjectType: "user",
      subjectId: input.subjectId,
      sessionId: `legacy:${input.subjectId}:0`,
      purpose: input.purpose,
      targetType: input.targetType,
      targetId: input.targetId,
      contextHash: stepUpContextHash({
        purpose: input.purpose,
        targetType: input.targetType,
        targetId: input.targetId,
        context: input.context,
      }),
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
  return raw;
}

async function configurePolicy(overrides: Record<string, unknown> = {}) {
  await prisma.withdrawalPolicy.upsert({
    where: { tenantId },
    create: {
      tenantId,
      active: true,
      minAmountPesewa: 0,
      maxAmountPesewa: 99_999_999,
      highValueThresholdPesewa: 10_000,
      highValueRequiresApproval: true,
      requiredApprovals: 1,
      separationOfDuties: true,
      requireStepUp: true,
      requirePaymentEvidence: true,
      requiredEvidenceFields: JSON.stringify(["paymentMethod", "paymentReference"]),
      ...overrides,
    },
    update: {
      highValueThresholdPesewa: 10_000,
      highValueRequiresApproval: true,
      requiredApprovals: 1,
      separationOfDuties: true,
      requireStepUp: true,
      requirePaymentEvidence: true,
      requiredEvidenceFields: JSON.stringify(["paymentMethod", "paymentReference"]),
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `P4-${Math.random().toString(36).slice(2, 8)}`,
      name: "Phase 4 Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  branchA = (
    await prisma.location.create({
      data: { tenantId, name: "Main", code: "P4-MAIN", status: "active" },
    })
  ).id;
  adminA = await createAdmin(`p4-a-${Math.random().toString(36).slice(2, 8)}@test.local`, "Admin A");
  adminB = await createAdmin(`p4-b-${Math.random().toString(36).slice(2, 8)}@test.local`, "Admin B");
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: `P4-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "Phase 4 Customer",
      phone: "+233270004400",
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  const account = await prisma.susuAccount.create({
    data: {
      tenantId,
      accountId: `P4-S-${Math.random().toString(36).slice(2, 8)}`,
      customerId,
      dailyContribution: 10,
      status: "active",
    },
  });
  accountId = account.id;
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId,
      accountId,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00Z"),
      endDate: new Date("2026-12-01T00:00:00Z"),
      dailyContribution: 10,
      status: "active",
      commissionCharged: false,
    },
  });
  cycleId = cycle.id;
  asAdmin(adminA);
  await recordContribution({
    accountId,
    amount: 300,
    channel: "direct_office",
    branchId: branchA,
    idempotencyKey: `P4-SEED-${Math.random().toString(36).slice(2, 8)}`,
  });
  asCustomer();
});

async function createHighValueRequest() {
  const created = await requestWithdrawal({
    accountId,
    amount: 200,
    reason: "Business stock needs payment today.",
  });
  expect(created.success, created.error).toBe(true);
  return created.data!.id;
}

describe("policy configuration", () => {
  it("returns the safe default when no row exists", async () => {
    asAdmin(adminA);
    const result = await getWithdrawalPolicy();
    expect(result.success).toBe(true);
    expect(result.data?.requiredApprovals).toBe(0);
  });

  it("saves policy with audit history", async () => {
    asAdmin(adminA);
    const result = await saveWithdrawalPolicy({
      active: true,
      minAmountPesewa: 0,
      maxAmountPesewa: 99_999_999,
      highValueThresholdPesewa: 10_000,
      highValueRequiresApproval: true,
      requiredApprovals: 1,
      separationOfDuties: true,
      requireStepUp: true,
      requirePaymentEvidence: true,
      requiredEvidenceFields: ["paymentMethod", "paymentReference"],
      changeNote: "Enterprise pilot policy",
    });
    expect(result.success, result.error).toBe(true);
    expect(await prisma.withdrawalPolicyHistory.count()).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: "withdrawal.policy_saved" } })
    ).toBe(1);
  });

  it("rejects an invalid policy", async () => {
    asAdmin(adminA);
    const result = await saveWithdrawalPolicy({
      active: true,
      minAmountPesewa: 5000,
      maxAmountPesewa: 1000,
      highValueThresholdPesewa: null,
      highValueRequiresApproval: false,
      requiredApprovals: 0,
      separationOfDuties: false,
      requireStepUp: true,
      requirePaymentEvidence: false,
      requiredEvidenceFields: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("staged high-value withdrawal", () => {
  beforeEach(async () => {
    await configurePolicy();
    asCustomer();
  });

  it("flags a high-value request without moving money", async () => {
    const id = await createHighValueRequest();
    const row = await prisma.customerWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(row.highValue).toBe(true);
    expect(row.requiredApprovals).toBe(1);
    expect(row.status).toBe("requested");
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("records approval without paying", async () => {
    const id = await createHighValueRequest();
    asAdmin(adminA);
    const token = await grant({
      purpose: "withdrawal.approve",
      subjectId: adminA.id,
      targetType: "customerWithdrawalRequest",
      targetId: id,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    const result = await approveWithdrawalRequest({ id, stepUpToken: token });
    expect(result.success, result.error).toBe(true);
    const row = await prisma.customerWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("awaiting_payment");
    expect(await prisma.withdrawal.count()).toBe(0);
    expect(await prisma.withdrawalApproval.count({ where: { requestId: id } })).toBe(1);
  });

  it("denies self-approval", async () => {
    const id = await createHighValueRequest();
    ctxHolder.current = { ...(ctxHolder.current as Record<string, unknown>), userId: customerId, role: "admin" };
    const result = await approveWithdrawalRequest({ id, stepUpToken: "any" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requester cannot approve/i);
  });

  it("denies payment before approval", async () => {
    const id = await createHighValueRequest();
    asAdmin(adminB);
    const result = await payWithdrawalRequest({
      id,
      stepUpToken: "any",
      paymentMethod: "cash",
      paymentReference: "PAY-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not awaiting payment/i);
  });

  it("enforces separation of duties and evidence, then pays once", async () => {
    const id = await createHighValueRequest();
    asAdmin(adminA);
    const approvalToken = await grant({
      purpose: "withdrawal.approve",
      subjectId: adminA.id,
      targetType: "customerWithdrawalRequest",
      targetId: id,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    expect((await approveWithdrawalRequest({ id, stepUpToken: approvalToken })).success).toBe(true);

    const sameApprover = await payWithdrawalRequest({
      id,
      stepUpToken: "any",
      paymentMethod: "cash",
      paymentReference: "PAY-1",
    });
    expect(sameApprover.success).toBe(false);
    expect(sameApprover.error).toMatch(/approver cannot also pay/i);

    asAdmin(adminB);
    const missingEvidence = await payWithdrawalRequest({
      id,
      stepUpToken: "any",
      paymentMethod: "",
      paymentReference: "",
    });
    expect(missingEvidence.success).toBe(false);
    expect(missingEvidence.error).toMatch(/payment method/i);

    const payToken = await grant({
      purpose: "withdrawal.pay",
      subjectId: adminB.id,
      targetType: "susuAccount",
      targetId: accountId,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    const paid = await payWithdrawalRequest({
      id,
      stepUpToken: payToken,
      paymentMethod: "cash",
      paymentReference: "PAY-REF-1",
      evidenceRef: null as never,
    });
    expect(paid.success, paid.error).toBe(true);
    const request = await prisma.customerWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(request.status).toBe("paid");
    expect(await prisma.withdrawal.count()).toBe(1);

    const duplicate = await payWithdrawalRequest({
      id,
      stepUpToken: "any",
      paymentMethod: "cash",
      paymentReference: "PAY-REF-2",
    });
    expect(duplicate.success).toBe(false);
    expect(await prisma.withdrawal.count()).toBe(1);
  });

  it("exposes the high-value queue", async () => {
    const id = await createHighValueRequest();
    asAdmin(adminA);
    const result = await getHighValueWithdrawalQueue();
    expect(result.success).toBe(true);
    expect(result.requests?.some((r) => r.id === id)).toBe(true);
  });

  it("allows two distinct concurrent approvals to complete the threshold", async () => {
    await configurePolicy({ requiredApprovals: 2, separationOfDuties: false });
    asCustomer();
    const id = await createHighValueRequest();
    const adminC = await createAdmin(`p4-c-${Math.random().toString(36).slice(2, 8)}@test.local`, "Admin C");
    const [tokenA, tokenC] = await Promise.all([
      grant({
        purpose: "withdrawal.approve",
        subjectId: adminA.id,
        targetType: "customerWithdrawalRequest",
        targetId: id,
        context: { amountMinor: "20000", currency: "GHS" },
      }),
      grant({
        purpose: "withdrawal.approve",
        subjectId: adminC.id,
        targetType: "customerWithdrawalRequest",
        targetId: id,
        context: { amountMinor: "20000", currency: "GHS" },
      }),
    ]);
    ctxHolder.queue.push(adminCtx(adminA), adminCtx(adminC));
    const results = await Promise.all([
      approveWithdrawalRequest({ id, stepUpToken: tokenA }),
      approveWithdrawalRequest({ id, stepUpToken: tokenC }),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(2);
    expect(await prisma.withdrawalApproval.count({ where: { requestId: id, status: "approved" } })).toBe(2);
    const row = await prisma.customerWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("awaiting_payment");
  });

  it("allows only one of two concurrent payments", async () => {
    await configurePolicy({ separationOfDuties: false });
    asCustomer();
    const id = await createHighValueRequest();
    asAdmin(adminA);
    const approvalToken = await grant({
      purpose: "withdrawal.approve",
      subjectId: adminA.id,
      targetType: "customerWithdrawalRequest",
      targetId: id,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    expect((await approveWithdrawalRequest({ id, stepUpToken: approvalToken })).success).toBe(true);
    const [payA, payB] = await Promise.all([
      grant({ purpose: "withdrawal.pay", subjectId: adminA.id, targetType: "susuAccount", targetId: accountId, context: { amountMinor: "20000", currency: "GHS" } }),
      grant({ purpose: "withdrawal.pay", subjectId: adminB.id, targetType: "susuAccount", targetId: accountId, context: { amountMinor: "20000", currency: "GHS" } }),
    ]);
    ctxHolder.queue.push(adminCtx(adminA), adminCtx(adminB));
    const attempts = await Promise.all([
      payWithdrawalRequest({ id, stepUpToken: payA, paymentMethod: "cash", paymentReference: "PAY-C-A" }),
      payWithdrawalRequest({ id, stepUpToken: payB, paymentMethod: "cash", paymentReference: "PAY-C-B" }),
    ]);
    expect(attempts.filter((r) => r.success)).toHaveLength(1);
    expect(await prisma.withdrawal.count()).toBe(1);
  });

  it("denies a cross-tenant request id", async () => {
    const id = await createHighValueRequest();
    const other = await prisma.businessTenant.create({
      data: { code: `P4-X-${Math.random().toString(36).slice(2, 6)}`, name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    ctxHolder.current = {
      tenantId: other.id,
      tenantName: "Other",
      tenantCode: "OX",
      userId: adminA.id,
      role: "admin",
      modules: ["susu"],
    };
    const result = await approveWithdrawalRequest({ id, stepUpToken: "any" });
    expect(result.success).toBe(false);
  });
});
