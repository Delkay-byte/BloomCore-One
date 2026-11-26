/**
 * Customer withdrawal requests.
 *
 * The rule under test: a request never moves money, it cannot exceed what the
 * cycle holds, one request at a time, and approval posts the withdrawal through
 * the existing action so the commission and receipt behaviour are unchanged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import {
  approveWithdrawalRequest,
  cancelMyWithdrawalRequest,
  getMyWithdrawalRequests,
  getWithdrawalRequests,
  rejectWithdrawalRequest,
  requestWithdrawal,
} from "@/lib/actions/withdrawal-request.actions";
import { recordContribution } from "@/lib/actions/susu-contribution.actions";
import {
  cycleAvailablePesewa,
  moneyToPesewa,
  toPesewa,
} from "@/lib/withdrawal-request";

let tenantId: string;
let adminId: string;
let customerId: string;
let accountId: string;
let cycleId: string;

async function asCustomer() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Withdrawal Tenant",
    tenantCode: "WT",
    userId: customerId,
    role: "customer",
    modules: ["customer"],
  };
}

async function asAdmin() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Withdrawal Tenant",
    tenantCode: "WT",
    userId: adminId,
    role: "admin",
    modules: ["susu"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `WRQ-${Math.random().toString(36).slice(2, 8)}`,
      name: "Withdrawal Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `wrq-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Withdrawal Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: `WRQ-C-${Math.random().toString(36).slice(2, 8)}`,
      fullName: "Withdrawal Customer",
      phone: "+233200000444",
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  const account = await prisma.susuAccount.create({
    data: {
      tenantId,
      accountId: `WRQ-S-${Math.random().toString(36).slice(2, 8)}`,
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
  await asAdmin();
  const paid = await recordContribution({
    accountId,
    amount: 200,
    channel: "direct_office",
    idempotencyKey: "WRQ-SEED-1",
  });
  expect(paid.success, paid.error).toBe(true);
  await asCustomer();
});

describe("requesting money", () => {
  it("records a request without moving money", async () => {
    const result = await requestWithdrawal({
      accountId,
      amount: 50,
      reason: "School fees are due next week.",
    });
    expect(result.success, result.error).toBe(true);
    expect(result.data?.amountPesewa).toBe(5000);
    expect(result.data?.status).toBe("requested");
    expect(result.data?.canCancel).toBe(true);

    expect(await prisma.withdrawal.count()).toBe(0);
    const request = await prisma.customerWithdrawalRequest.findFirstOrThrow();
    expect(request.status).toBe("requested");
    expect(request.amountPesewa).toBe(5000);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "customer.withdrawal_requested" },
    });
    expect(JSON.parse(String(audit?.details)).financialMutation).toBe(false);
  });

  it("refuses a reason that does not explain anything", async () => {
    const result = await requestWithdrawal({ accountId, amount: 10, reason: "money" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explain/i);
  });

  it("refuses an amount with a fractional pesewa", async () => {
    expect(toPesewa(10.555).error).toMatch(/two decimal places/i);
    const result = await requestWithdrawal({
      accountId,
      amount: 10.555,
      reason: "I need part of my savings now.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/two decimal places/i);
  });

  it("refuses more than the cycle holds", async () => {
    const result = await requestWithdrawal({
      accountId,
      amount: 500,
      reason: "I want to withdraw more than I saved.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/can withdraw up to/i);
  });

  it("allows only one open request per account", async () => {
    const first = await requestWithdrawal({
      accountId,
      amount: 20,
      reason: "Transport money for the week.",
    });
    expect(first.success, first.error).toBe(true);
    const second = await requestWithdrawal({
      accountId,
      amount: 20,
      reason: "A second request while one is open.",
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already have a request waiting/i);
  });

  it("refuses an account that belongs to someone else", async () => {
    const other = await prisma.customer.create({
      data: {
        tenantId,
        customerId: "WRQ-OTHER",
        fullName: "Other Customer",
        status: "active",
        portalEnabled: true,
      },
    });
    const otherAccount = await prisma.susuAccount.create({
      data: {
        tenantId,
        accountId: "WRQ-S-OTHER",
        customerId: other.id,
        dailyContribution: 10,
        status: "active",
      },
    });
    const result = await requestWithdrawal({
      accountId: otherAccount.id,
      amount: 10,
      reason: "Trying to withdraw from another account.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not yours/i);
  });

  it("counts a previous withdrawal against the balance", async () => {
    await asAdmin();
    const withdrawal = await prisma.withdrawal.create({
      data: {
        tenantId,
        accountId,
        cycleId,
        requestedAmount: 150,
        commissionAmount: 0,
        netAmount: 150,
        remainingBalance: 50,
        authorizedById: adminId,
        referenceId: "WRQ-W-1",
      },
    });
    expect(withdrawal.id).toBeTruthy();
    await asCustomer();
    const result = await requestWithdrawal({
      accountId,
      amount: 100,
      reason: "Asking for more than is left.",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/can withdraw up to/i);
  });
});

describe("cancelling and deciding", () => {
  it("lets the customer cancel a waiting request and frees the balance", async () => {
    const created = await requestWithdrawal({
      accountId,
      amount: 30,
      reason: "I need cash for an emergency.",
    });
    expect(created.success).toBe(true);
    const cancelled = await cancelMyWithdrawalRequest(created.data!.id);
    expect(cancelled.success, cancelled.error).toBe(true);
    expect(cancelled.data?.status).toBe("cancelled");

    const again = await requestWithdrawal({
      accountId,
      amount: 30,
      reason: "I need cash after all, same amount.",
    });
    expect(again.success, again.error).toBe(true);
  });

  it("declines with a required reason and frees the balance", async () => {
    const created = await requestWithdrawal({
      accountId,
      amount: 30,
      reason: "I need cash for an emergency.",
    });
    await asAdmin();
    const short = await rejectWithdrawalRequest({ id: created.data!.id, note: "no" });
    expect(short.success).toBe(false);

    const declined = await rejectWithdrawalRequest({
      id: created.data!.id,
      note: "The account was opened last week; please wait for the cycle to mature.",
    });
    expect(declined.success, declined.error).toBe(true);
    expect(declined.data?.status).toBe("rejected");
    expect(await prisma.withdrawal.count()).toBe(0);
  });

  it("does not let one office decline another tenant's request", async () => {
    const created = await requestWithdrawal({
      accountId,
      amount: 30,
      reason: "I need cash for an emergency.",
    });
    const otherTenant = await prisma.businessTenant.create({
      data: {
        code: "WRQ-OTHER-TENANT",
        name: "Other Tenant",
        status: "ACTIVE",
        susuEnabled: true,
      },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `wrq-other-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Other Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    ctxHolder.current = {
      tenantId: otherTenant.id,
      tenantName: "Other Tenant",
      tenantCode: "OT",
      userId: otherAdmin.id,
      role: "admin",
      modules: ["susu"],
    };
    const attempt = await rejectWithdrawalRequest({
      id: created.data!.id,
      note: "Trying to decide another tenant's request.",
    });
    expect(attempt.success).toBe(false);
    expect(attempt.error).toMatch(/not found/i);
    const queue = await getWithdrawalRequests({ status: "open" });
    expect(queue.requests).toHaveLength(0);
  });

  it("shows the office queue oldest first with the customer's reason", async () => {
    await requestWithdrawal({
      accountId,
      amount: 25,
      reason: "Rent is due at the end of the month.",
    });
    await asAdmin();
    const queue = await getWithdrawalRequests({ status: "open" });
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests?.[0].reason).toMatch(/rent is due/i);
    expect(queue.requests?.[0].amountLabel).toContain("25.00");
  });

  it("keeps a customer's own list scoped to that customer", async () => {
    await requestWithdrawal({
      accountId,
      amount: 25,
      reason: "Rent is due at the end of the month.",
    });
    const other = await prisma.customer.create({
      data: {
        tenantId,
        customerId: "WRQ-OTHER-2",
        fullName: "Another Customer",
        status: "active",
        portalEnabled: true,
      },
    });
    ctxHolder.current = {
      tenantId,
      tenantName: "Withdrawal Tenant",
      tenantCode: "WT",
      userId: other.id,
      role: "customer",
      modules: ["customer"],
    };
    const mine = await getMyWithdrawalRequests();
    expect(mine.requests).toHaveLength(0);
  });
});

describe("approval", () => {
  it("refuses without a step-up grant and records nothing", async () => {
    const created = await requestWithdrawal({
      accountId,
      amount: 40,
      reason: "I need to pay a hospital bill.",
    });
    await asAdmin();
    const result = await approveWithdrawalRequest({
      id: created.data!.id,
      stepUpToken: "not-a-real-grant",
    });
    expect(result.success).toBe(false);
    expect(await prisma.withdrawal.count()).toBe(0);
    const request = await prisma.customerWithdrawalRequest.findFirstOrThrow();
    expect(request.status).toBe("requested");
  });

  it("refuses to approve a request that was already declined", async () => {
    const created = await requestWithdrawal({
      accountId,
      amount: 40,
      reason: "I need to pay a hospital bill.",
    });
    await asAdmin();
    await rejectWithdrawalRequest({
      id: created.data!.id,
      note: "Please visit the branch with your card first.",
    });
    const result = await approveWithdrawalRequest({
      id: created.data!.id,
      stepUpToken: "any",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already declined/i);
  });
});

describe("money helpers", () => {
  it("converts stored decimals to integer pesewa without drift", () => {
    expect(moneyToPesewa(10.1)).toBe(1010);
    expect(moneyToPesewa("10.05")).toBe(1005);
    expect(moneyToPesewa({ toNumber: () => 0.07 })).toBe(7);
    expect(moneyToPesewa(null)).toBe(0);
  });

  it("reports what is left in a cycle, never below zero", () => {
    const available = cycleAvailablePesewa({
      contributions: [{ amount: 100 }, { amount: 25.5 }],
      withdrawals: [{ requestedAmount: 20 }],
      commissions: [{ amount: 10 }],
    });
    expect(available).toBe(9550);
    expect(
      cycleAvailablePesewa({ contributions: [], withdrawals: [], commissions: [] })
    ).toBe(0);
    expect(
      cycleAvailablePesewa({
        contributions: [{ amount: 10 }],
        withdrawals: [{ requestedAmount: 20 }],
        commissions: [],
      })
    ).toBe(0);
  });
});
