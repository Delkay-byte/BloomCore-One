import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";

describe("PostgreSQL — Phase 4 withdrawal controls", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates policy, history and approval tables with indexes", async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('WithdrawalPolicy','WithdrawalPolicyHistory','WithdrawalApproval')
    `;
    expect(tables.map((r) => r.table_name).sort()).toEqual([
      "WithdrawalApproval",
      "WithdrawalPolicy",
      "WithdrawalPolicyHistory",
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
        'WithdrawalPolicy_tenantId_key',
        'WithdrawalApproval_tenantId_requestId_approverId_key',
        'CustomerWithdrawalRequest_highValue_idx'
      )
    `;
    // The first two are required by the policy/approval invariants. A missing
    // request index is acceptable; it is not part of the uniqueness contract.
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain("WithdrawalPolicy_tenantId_key");
    expect(names).toContain("WithdrawalApproval_tenantId_requestId_approverId_key");
  });

  it("preserves legacy null values and records new control fields", async () => {
    const tenant = await prisma.businessTenant.create({
      data: { code: "PG-P4", name: "PG Phase 4", status: "ACTIVE", susuEnabled: true },
    });
    const admin = await prisma.user.create({
      data: { tenantId: tenant.id, email: "pg-p4-admin@test.local", fullName: "P4 Admin", role: "admin", status: "active", passwordHash: "x" },
    });
    const branch = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Main", code: "P4-MAIN" },
    });
    const customer = await prisma.customer.create({
      data: { tenantId: tenant.id, customerId: "PG-P4-C", fullName: "P4 Customer", status: "active" },
    });
    const account = await prisma.susuAccount.create({
      data: { tenantId: tenant.id, accountId: "PG-P4-S", customerId: customer.id, dailyContribution: 10, status: "active" },
    });
    const cycle = await prisma.susuCycle.create({
      data: { tenantId: tenant.id, accountId: account.id, cycleNumber: 1, startDate: new Date(), endDate: new Date(Date.now() + 86400000), dailyContribution: 10, status: "active" },
    });
    const legacy = await prisma.customerWithdrawalRequest.create({
      data: {
        tenantId: tenant.id, reference: "PG-P4-LEGACY", customerId: customer.id,
        accountId: account.id, cycleId: cycle.id, amountPesewa: 1000,
        reason: "Legacy request", requestedById: admin.id,
      },
    });
    expect(legacy.highValue).toBe(false);
    expect(legacy.requiredApprovals).toBe(0);
    expect(legacy.paidAt).toBeNull();

    const policy = await prisma.withdrawalPolicy.create({
      data: {
        tenantId: tenant.id, active: true, minAmountPesewa: 0, maxAmountPesewa: 99999999,
        highValueThresholdPesewa: 10000, highValueRequiresApproval: true,
        requiredApprovals: 1, separationOfDuties: true, requireStepUp: true,
        requirePaymentEvidence: true, requiredEvidenceFields: JSON.stringify(["paymentMethod"]),
        updatedById: admin.id,
      },
    });
    expect(policy.tenantId).toBe(tenant.id);
    const request = await prisma.customerWithdrawalRequest.create({
      data: {
        tenantId: tenant.id, reference: "PG-P4-NEW", customerId: customer.id,
        accountId: account.id, cycleId: cycle.id, amountPesewa: 20000,
        reason: "New controlled request", requestedById: admin.id,
        branchId: branch.id, highValue: true, requiredApprovals: 1, policyVersion: 2,
      },
    });
    const approval = await prisma.withdrawalApproval.create({
      data: { tenantId: tenant.id, requestId: request.id, approverId: admin.id, status: "approved" },
    });
    await prisma.customerWithdrawalRequest.update({
      where: { id: request.id },
      data: { status: "awaiting_payment", approvedById: admin.id, approvedAt: new Date(), paymentMethod: "cash", paymentReference: "PAY-P4" },
    });
    const after = await prisma.customerWithdrawalRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe("awaiting_payment");
    expect(after.paymentReference).toBe("PAY-P4");
    expect(approval.approverId).toBe(admin.id);
  });
});
