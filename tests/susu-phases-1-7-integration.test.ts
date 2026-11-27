/**
 * Phases 1–7 integration — the phases must work TOGETHER.
 *
 * Each scenario drives two or more phases through their real server actions and
 * asserts the seam between them: a customer registered in Phase 7 is collected
 * on in Phase 2 and reported on in Phase 6; Phase 3 cash is closed in Phase 5;
 * Phase 4 withdrawal controls govern a live request while Phase 5 reconciliation
 * stays independent; Phase 6 branch scope holds after Phase 7 gave accounts a
 * branch; Phase 7 imports move identity without inventing money.
 *
 * Only the request plumbing is mocked (next/headers, next/navigation,
 * next/cache). Authorisation, tenant and branch scope are the real ones.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import { prisma, cleanDatabase, createTestTenant } from "./setup";

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
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { registerCustomerOnboarding } from "@/lib/actions/susu-onboarding.actions";
import {
  createImportBatch,
  validateImportBatch,
  getImportPreview,
  confirmImportBatch,
} from "@/lib/actions/susu-import.actions";
import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import {
  acknowledgeRemittanceReceipt,
  declareRemittance,
  getCollectorRemittancePosition,
  verifyRemittance,
} from "@/lib/actions/susu-remittance.actions";
import {
  openDailyCollectorClosing,
  declareDailyClosing,
  recordDailyClosingHandover,
  receiveDailyClosing,
  closeDailyClosing,
  openReconciliationSession,
  reconcileSession,
} from "@/lib/actions/susu-reconciliation.actions";
import {
  approveWithdrawalRequest,
  getWithdrawalPolicy,
  payWithdrawalRequest,
  saveWithdrawalPolicy,
} from "@/lib/actions/withdrawal-control.actions";
import { requestWithdrawal } from "@/lib/actions/withdrawal-request.actions";
import {
  exportSusuReport,
  getBranchReport,
  getCollectorPerformanceReport,
  getContributionReport,
  getCustomerStatement,
  getCycleReport,
  getSusuOverview,
} from "@/lib/actions/susu-reporting.actions";
import {
  hashStepUpToken,
  stepUpContextHash,
  type StepUpPurpose,
} from "@/lib/security/step-up";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const MONTH_START = new Date("2026-11-01T00:00:00Z");
const MONTH_END = new Date("2026-12-01T00:00:00Z");

type SessionUser = { id: string; tenantId: string | null; email: string };

async function signSession(
  cookie: string,
  payload: Record<string, unknown>,
  record: { subjectType: "user" | "customer"; subjectId: string; tenantId: string }
) {
  const now = Math.floor(Date.now() / 1000);
  const jti = `p17-${randomBytes(8).toString("hex")}`;
  await createSessionRecord({
    id: jti,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    tenantId: record.tenantId,
    expiresAt: new Date((now + 3600) * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    cookie,
    await new SignJWT({ ...payload, jti, iat: now })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

async function asAdmin(user: SessionUser) {
  if (!user.tenantId) throw new Error("fixture admin has no tenant");
  await signSession(
    "bik-admin-session",
    {
      userId: user.id,
      email: user.email,
      fullName: "Integration Admin",
      role: "admin",
      modules: ["susu"],
      tokenVersion: 0,
      lastActivityAt: Math.floor(Date.now() / 1000),
    },
    { subjectType: "user", subjectId: user.id, tenantId: user.tenantId }
  );
}

async function asCustomer(customer: { id: string; tenantId: string | null; phone: string | null }) {
  if (!customer.tenantId) throw new Error("fixture customer has no tenant");
  await signSession(
    "bik-customer-session",
    {
      userId: customer.id,
      email: customer.phone ?? undefined,
      fullName: "Portal Customer",
      role: "customer",
      modules: ["susu", "customer"],
      tokenVersion: 0,
    },
    { subjectType: "customer", subjectId: customer.id, tenantId: customer.tenantId }
  );
}

function todayUtc(): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

/** Tenant + two branches + a company-wide admin. */
async function tenantFixture() {
  const tenant = await createTestTenant({ susu: true, momo: false });
  const branchA = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Airport Branch", code: `A-${randomBytes(2).toString("hex")}`, status: "active" },
  });
  const branchB = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Tema Branch", code: `B-${randomBytes(2).toString("hex")}`, status: "active" },
  });
  const admin = await createAdmin(tenant.id, "Company Admin");
  return { tenant, branchA, branchB, admin };
}

async function createAdmin(tenantId: string, fullName: string) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `p17-${randomBytes(6).toString("hex")}@bikprestige.test`,
      fullName,
      role: "admin",
      status: "active",
      passwordHash: "synthetic",
      susuEnabled: true,
    },
  });
}

async function createCollector(tenantId: string, branchId: string) {
  const user = await prisma.user.create({
    data: {
      tenantId,
      email: `p17-coll-${randomBytes(6).toString("hex")}@bikprestige.test`,
      fullName: "Integration Collector",
      role: "collector",
      status: "active",
      passwordHash: "synthetic",
      susuEnabled: true,
      locationId: branchId,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId, userId: user.id, status: "active", branchId },
  });
  return { user, collector };
}

/** Customer + account + cycle with the branch of record already set. */
async function seedAccount(input: {
  tenantId: string;
  branchId: string;
  dailyContribution?: number;
  fullName?: string;
}) {
  const customer = await prisma.customer.create({
    data: {
      tenantId: input.tenantId,
      customerId: `P17-C-${randomBytes(4).toString("hex")}`,
      fullName: input.fullName ?? "Integration Customer",
      phone: `+2332${randomBytes(4).toString("hex").slice(0, 7)}`,
      status: "active",
      portalEnabled: true,
      registeredBranchId: input.branchId,
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      tenantId: input.tenantId,
      accountId: `P17-S-${randomBytes(4).toString("hex")}`,
      customerId: customer.id,
      dailyContribution: input.dailyContribution ?? 10,
      status: "active",
      cardCustody: "customer",
      branchId: input.branchId,
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId: input.tenantId,
      accountId: account.id,
      cycleNumber: 1,
      startDate: MONTH_START,
      endDate: MONTH_END,
      dailyContribution: input.dailyContribution ?? 10,
      status: "active",
      commissionCharged: false,
    },
  });
  return { customer, account, cycle };
}

/** Bind a customer to a collector so collector-channel cash can be recorded. */
async function assignCollector(input: {
  tenantId: string;
  collectorId: string;
  customerId: string;
  accountId: string;
}) {
  await prisma.collectorCustomerAssignment.create({
    data: {
      tenantId: input.tenantId,
      collectorId: input.collectorId,
      customerId: input.customerId,
      accountId: input.accountId,
      active: true,
      activeAccountKey: input.accountId,
    },
  });
}

async function readJti(token: string): Promise<string> {
  const [, payload] = token.split(".");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { jti?: string };
  if (!parsed.jti) throw new Error("session token has no jti");
  return parsed.jti;
}

async function grantStepUp(input: {
  purpose: StepUpPurpose;
  subjectId: string;
  targetType: string;
  targetId: string;
  context: Record<string, unknown>;
}): Promise<string> {
  const raw = `p17-stepup-${randomBytes(8).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  const session = mockCookieStore.get("bik-admin-session") ?? "";
  const jti = await readJti(session);
  await prisma.stepUpGrant.create({
    data: {
      tokenHash: hashStepUpToken(raw),
      subjectType: "user",
      subjectId: input.subjectId,
      sessionId: jti,
      purpose: input.purpose,
      targetType: input.targetType,
      targetId: input.targetId,
      contextHash: stepUpContextHash({
        purpose: input.purpose,
        targetType: input.targetType,
        targetId: input.targetId,
        context: input.context,
      }),
      expiresAt: new Date((now + 300) * 1000),
    },
  });
  return raw;
}

beforeEach(async () => {
  mockCookieStore.clear();
  await cleanDatabase();
});

// ---------------------------------------------------------------------------
// 1. Onboarding -> collection -> reporting
// ---------------------------------------------------------------------------
describe("integration — Phase 7 onboarding feeds Phase 2 collection and Phase 6 reporting", () => {
  it("collects on a newly registered customer and reports the branch it belongs to", async () => {
    const { tenant, branchA, admin } = await tenantFixture();
    const { collector } = await createCollector(tenant.id, branchA.id);
    await asAdmin(admin);

    const form = new FormData();
    form.set("fullName", "Ama Boateng");
    form.set("phone", "0244777888");
    form.set("dailyContribution", "10");
    form.set("branchId", branchA.id);
    form.set("collectorId", collector.id);
    form.set("externalReference", "PB-100");

    const registered = await registerCustomerOnboarding(form);
    expect(registered.success, registered.error).toBe(true);
    const created = registered.data as {
      customer: { id: string; customerId: string };
      susuAccount: { id: string; accountId: string; branchId: string | null };
    };
    expect(created.susuAccount.branchId).toBe(branchA.id);

    const collected = await recordContribution({
      accountId: created.susuAccount.id,
      amount: 50,
      channel: "collector",
      collectorId: collector.id,
      idempotencyKey: `p17-onboard-${randomBytes(4).toString("hex")}`,
    });
    expect(collected.success, collected.error).toBe(true);

    const contribution = await prisma.contribution.findFirstOrThrow({
      where: { accountId: created.susuAccount.id },
    });
    expect(Number(contribution.amount)).toBe(50);
    // The Phase 1/2 branch attribution and the Phase 7 account branch agree.
    expect(contribution.branchId).toBe(branchA.id);

    const contributions = await getContributionReport({ page: 1, limit: 50 });
    expect(contributions.success, contributions.error).toBe(true);
    expect(contributions.data!.totals.netAmount).toBe(50);

    const cycles = await getCycleReport({ page: 1, limit: 50 });
    expect(cycles.success, cycles.error).toBe(true);
    expect(cycles.data!.cycles).toHaveLength(1);
    expect(cycles.data!.cycles[0].branchId).toBe(branchA.id);
    expect(cycles.data!.cycles[0].branchName).toBe("Airport Branch");
    expect(cycles.data!.cycles[0].contributionsAmount).toBe(50);

    const statement = await getCustomerStatement(created.susuAccount.id);
    expect(statement.success, statement.error).toBe(true);
    expect(statement.data!.summary.credits).toBe(50);

    const branches = await getBranchReport({});
    expect(branches.success, branches.error).toBe(true);
    const row = branches.data!.branches.find((b) => b.branchId === branchA.id);
    expect(row?.contributionAmount).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 2. Contribution -> remittance -> daily closing
// ---------------------------------------------------------------------------
describe("integration — Phase 2/3 cash is closed through Phase 5 daily closing", () => {
  it("closes the day and settles the collector position for the same cash", async () => {
    const { tenant, branchA, admin } = await tenantFixture();
    const collectorUser = await createCollector(tenant.id, branchA.id);
    const handoverAdmin = await createAdmin(tenant.id, "Handover Admin");
    const receiverAdmin = await createAdmin(tenant.id, "Receiver Admin");
    const verifierAdmin = await createAdmin(tenant.id, "Finance Verifier");
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: verifierAdmin.id, locationId: branchA.id, role: "finance", status: "active" },
    });
    const { account, customer } = await seedAccount({ tenantId: tenant.id, branchId: branchA.id });
    await assignCollector({
      tenantId: tenant.id,
      collectorId: collectorUser.collector.id,
      customerId: customer.id,
      accountId: account.id,
    });

    await asAdmin(admin);
    for (const amount of [100, 100]) {
      const recorded = await recordContribution({
        accountId: account.id,
        amount,
        channel: "collector",
        collectorId: collectorUser.collector.id,
        idempotencyKey: `p17-close-${randomBytes(4).toString("hex")}`,
      });
      expect(recorded.success, recorded.error).toBe(true);
    }

    const opened = await openDailyCollectorClosing({
      collectorId: collectorUser.collector.id,
      closingDate: todayUtc(),
    });
    expect(opened.success, opened.error).toBe(true);
    const closingId = opened.data!.id;
    expect(Number(opened.data!.expectedCash)).toBe(200);

    expect((await declareDailyClosing({ closingId, declaredCash: 200 })).success).toBe(true);

    await asAdmin(handoverAdmin);
    const handover = await recordDailyClosingHandover({ closingId, handoverAmount: 200 });
    expect(handover.success, handover.error).toBe(true);

    await asAdmin(receiverAdmin);
    const received = await receiveDailyClosing({
      closingId,
      receivedAmount: 200,
      evidenceRef: "P17-RECEIPT-1",
    });
    expect(received.success, received.error).toBe(true);

    const closed = await closeDailyClosing({ closingId });
    expect(closed.success, closed.error).toBe(true);
    const closing = await prisma.dailyCollectorClosing.findUniqueOrThrow({ where: { id: closingId } });
    expect(closing.status).toBe("balanced");

    // The same cash is then declared, received and verified through Phase 3.
    await asAdmin(admin);
    const declared = await declareRemittance({
      collectorId: collectorUser.collector.id,
      declaredAmount: 200,
    });
    expect(declared.success, declared.error).toBe(true);
    expect(Number((declared.data as { expectedAmount: number | string }).expectedAmount)).toBe(200);
    const remittanceId = (declared.data as { id: string }).id;

    await asAdmin(receiverAdmin);
    expect((await acknowledgeRemittanceReceipt({ remittanceId, receivedAmount: 200 })).success).toBe(true);

    await asAdmin(verifierAdmin);
    const verified = await verifyRemittance({ remittanceId, verifiedAmount: 200 });
    expect(verified.success, verified.error).toBe(true);

    const position = await getCollectorRemittancePosition(collectorUser.collector.id);
    expect(position?.outstanding).toBe(0);
    expect(position?.settled).toBe(200);

    await asAdmin(admin);
    const overview = await getSusuOverview({});
    expect(overview.success, overview.error).toBe(true);
    expect(overview.data!.remittanceActivity.verified).toBe(200);
    expect(overview.data!.outstandingBalances).toBe(0);

    const performance = await getCollectorPerformanceReport({});
    expect(performance.success, performance.error).toBe(true);
    const row = performance.data!.collectors.find((c) => c.id === collectorUser.collector.id);
    expect(row?.verifiedAmount).toBe(200);
    expect(row?.outstandingAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Withdrawal controls beside reconciliation
// ---------------------------------------------------------------------------
describe("integration — Phase 4 controls govern a payout, Phase 5 stays independent", () => {
  it("approves and pays a high-value request without inventing a reconciliation case", async () => {
    const { tenant, branchA, admin } = await tenantFixture();
    const approver = await createAdmin(tenant.id, "Approver");
    const payer = await createAdmin(tenant.id, "Payer");
    const { account, customer } = await seedAccount({ tenantId: tenant.id, branchId: branchA.id });
    const { collector } = await createCollector(tenant.id, branchA.id);
    await assignCollector({
      tenantId: tenant.id,
      collectorId: collector.id,
      customerId: customer.id,
      accountId: account.id,
    });

    await asAdmin(admin);
    const saved = await saveWithdrawalPolicy({
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
      changeNote: "Integration rehearsal policy",
    });
    expect(saved.success, saved.error).toBe(true);

    const deposited = await recordContribution({
      accountId: account.id,
      amount: 300,
      channel: "collector",
      collectorId: collector.id,
      idempotencyKey: `p17-withdraw-${randomBytes(4).toString("hex")}`,
    });
    expect(deposited.success, deposited.error).toBe(true);

    await asCustomer(customer);
    const requested = await requestWithdrawal({
      accountId: account.id,
      amount: 200,
      reason: "School fees due today",
    });
    expect(requested.success, requested.error).toBe(true);
    const requestId = (requested.data as { id: string }).id;

    await asAdmin(approver);
    const approvalToken = await grantStepUp({
      purpose: "withdrawal.approve",
      subjectId: approver.id,
      targetType: "customerWithdrawalRequest",
      targetId: requestId,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    const approved = await approveWithdrawalRequest({ id: requestId, stepUpToken: approvalToken });
    expect(approved.success, approved.error).toBe(true);

    await asAdmin(payer);
    const payToken = await grantStepUp({
      purpose: "withdrawal.pay",
      subjectId: payer.id,
      targetType: "susuAccount",
      targetId: account.id,
      context: { amountMinor: "20000", currency: "GHS" },
    });
    const paid = await payWithdrawalRequest({
      id: requestId,
      stepUpToken: payToken,
      paymentMethod: "cash",
      paymentReference: "P17-PAY-1",
    });
    expect(paid.success, paid.error).toBe(true);
    expect(await prisma.withdrawal.count({ where: { accountId: account.id } })).toBe(1);

    // Phase 5 remains its own ledger: a paid withdrawal does not silently
    // become a reconciliation case, and a clean session balances.
    const session = await openReconciliationSession({
      type: "branch_close",
      branchId: branchA.id,
      collectorId: null,
      periodStart: todayUtc(),
      periodEnd: todayUtc(),
    });
    expect(session.success, session.error).toBe(true);
    const reconciled = await reconcileSession(session.data!.id);
    expect(reconciled.success, reconciled.error).toBe(true);
    expect(await prisma.reconciliationExceptionCase.count()).toBe(0);

    // The policy that governed the payout is still the stored policy.
    await asAdmin(admin);
    const policy = await getWithdrawalPolicy();
    expect(policy.success).toBe(true);
    expect(policy.data?.highValueThresholdPesewa).toBe(10_000);

    const audit = await prisma.auditLog.findMany({
      where: {
        action: {
          in: [
            "withdrawal.policy_saved",
            "withdrawal.approval_recorded",
            "withdrawal.payment_recorded",
          ],
        },
      },
      select: { action: true },
    });
    const seen = new Set(audit.map((row) => row.action));
    expect(seen.has("withdrawal.policy_saved")).toBe(true);
    expect(seen.has("withdrawal.approval_recorded")).toBe(true);
    expect(seen.has("withdrawal.payment_recorded")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Phase 6 branch scope over Phase 7 account branches
// ---------------------------------------------------------------------------
describe("integration — cycle reporting honours the Phase 7 account branch", () => {
  it("scopes cycles and their money to the branch the reader holds", async () => {
    const { tenant, branchA, branchB, admin } = await tenantFixture();
    const branchManager = await createAdmin(tenant.id, "Airport Manager");
    await prisma.branchMembership.create({
      data: { tenantId: tenant.id, userId: branchManager.id, locationId: branchA.id, role: "branch_manager", status: "active" },
    });

    const a = await seedAccount({ tenantId: tenant.id, branchId: branchA.id, fullName: "Branch A Customer" });
    const b = await seedAccount({ tenantId: tenant.id, branchId: branchB.id, fullName: "Branch B Customer" });

    await asAdmin(admin);
    for (const input of [
      { accountId: a.account.id, branchId: branchA.id, amount: 100 },
      { accountId: b.account.id, branchId: branchB.id, amount: 70 },
    ]) {
      const recorded = await recordContribution({
        accountId: input.accountId,
        amount: input.amount,
        channel: "direct_office",
        branchId: input.branchId,
        idempotencyKey: `p17-scope-${randomBytes(4).toString("hex")}`,
      });
      expect(recorded.success, recorded.error).toBe(true);
    }

    // An anomalous row that points branch-B money at the branch-A cycle must
    // not leak into the branch-A aggregate.
    await prisma.contribution.create({
      data: {
        tenantId: tenant.id,
        branchId: branchB.id,
        accountId: b.account.id,
        cycleId: a.cycle.id,
        amount: 999,
        collectionDate: new Date(),
        channel: "direct_office",
        recordedById: admin.id,
        referenceId: `P17-ANOMALY-${randomBytes(4).toString("hex")}`,
      },
    });

    await asAdmin(branchManager);
    const scoped = await getCycleReport({ page: 1, limit: 50 });
    expect(scoped.success, scoped.error).toBe(true);
    expect(scoped.data!.cycles).toHaveLength(1);
    expect(scoped.data!.cycles[0].branchId).toBe(branchA.id);
    expect(scoped.data!.cycles[0].contributionsAmount).toBe(100);

    const outOfScope = await getCycleReport({ branchId: branchB.id });
    expect(outOfScope.success).toBe(false);
    expect(outOfScope.error).toMatch(/scope/i);

    const scopedContributions = await getContributionReport({ page: 1, limit: 50 });
    expect(scopedContributions.data!.totals.netAmount).toBe(100);

    await asAdmin(admin);
    const companyWide = await getCycleReport({ page: 1, limit: 50 });
    expect(companyWide.data!.cycles).toHaveLength(2);

    const narrow = await getCycleReport({ branchId: branchB.id, page: 1, limit: 50 });
    expect(narrow.success, narrow.error).toBe(true);
    expect(narrow.data!.cycles).toHaveLength(1);
    expect(narrow.data!.cycles[0].contributionsAmount).toBe(70);

    const csv = await exportSusuReport({ report: "cycles", branchId: branchA.id });
    expect(csv.success, csv.error).toBe(true);
    expect(csv.data!.csv).toContain("Branch A Customer");
    expect(csv.data!.csv).not.toContain("Branch B Customer");
  });
});

// ---------------------------------------------------------------------------
// 5. Bulk import -> identity, never money
// ---------------------------------------------------------------------------
describe("integration — Phase 7 bulk import lands in the reporting spine", () => {
  it("imports customers, refuses to invent money, and is tenant isolated", async () => {
    const { tenant, branchA, admin } = await tenantFixture();
    const register =
      "Full name,Phone,Daily contribution,Customer reference\n" +
      "Yaw Mensah,0244555666,50,PB-200\n" +
      "Efua Owusu,0244555777,20,PB-201\n";

    await asAdmin(admin);
    const form = new FormData();
    form.set("name", "Integration import");
    form.set("branchId", branchA.id);
    form.set("file", new File([register], "customers.csv", { type: "text/csv" }));

    const staged = await createImportBatch(form);
    expect(staged.success, staged.error).toBe(true);
    const batchId = (staged.data as { batchId: string }).batchId;

    const validated = await validateImportBatch({ batchId });
    expect(validated.success, validated.error).toBe(true);
    const preview = await getImportPreview({ batchId });
    expect(preview.success, preview.error).toBe(true);
    const plan = preview.data as { planHash: string; rows: unknown[] };
    expect(plan.rows).toHaveLength(2);

    const committed = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success, committed.error).toBe(true);

    const imported = await prisma.customer.findMany({
      where: { tenantId: tenant.id, registeredVia: "import" },
      include: { accounts: { include: { cycles: true } } },
    });
    expect(imported).toHaveLength(2);
    for (const customer of imported) {
      expect(customer.accounts).toHaveLength(1);
      expect(customer.accounts[0].branchId).toBe(branchA.id);
      expect(customer.accounts[0].cycles).toHaveLength(1);
    }
    expect(await prisma.contribution.count()).toBe(0);
    expect(await prisma.withdrawal.count()).toBe(0);
    expect(await prisma.commission.count()).toBe(0);

    // Imported identity is immediately collectable and reportable.
    const target = imported[0].accounts[0];
    const recorded = await recordContribution({
      accountId: target.id,
      amount: 50,
      channel: "direct_office",
      branchId: branchA.id,
      idempotencyKey: `p17-import-${randomBytes(4).toString("hex")}`,
    });
    expect(recorded.success, recorded.error).toBe(true);

    const report = await getBranchReport({});
    expect(report.data!.branches.find((row) => row.branchId === branchA.id)?.contributionAmount).toBe(50);

    // A different tenant can neither preview nor commit this batch.
    const otherTenant = await createTestTenant({ susu: true, momo: false });
    const outsider = await createAdmin(otherTenant.id, "Outsider");
    await asAdmin(outsider);
    const foreignPreview = await getImportPreview({ batchId });
    expect(foreignPreview.success).toBe(false);
    const foreignCommit = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(foreignCommit.success).toBe(false);
  });
});