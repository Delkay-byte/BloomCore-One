/**
 * Shared fixtures for the Phase 5 reconciliation test suites.
 *
 * All rows are synthetic and tenant-scoped. Nothing here bypasses server
 * authorization: tests call the exported server actions with a signed session.
 */

import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import { prisma } from "./setup";
import { money } from "@/lib/finance/remittance-settlement";
import {
  openReconciliationSession,
  reconcileSession,
  getReconciliationSession,
} from "@/lib/actions/susu-reconciliation.actions";
import {
  openExceptionCase,
  getExceptionCase,
  type ExceptionCaseView,
} from "@/lib/actions/susu-exception-cases.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

export type TestUser = { id: string; tenantId: string | null; email: string };

export function sessionSetter(store: Map<string, string>) {
  return async function setSession(
    user: TestUser,
    role: "admin" | "collector" = "admin"
  ) {
    if (!user.tenantId) throw new Error("test user has no tenant");
    const now = Math.floor(Date.now() / 1000);
    const jti = `p5-${role}-${now}-${Math.random().toString(16).slice(2)}`;
    await createSessionRecord({
      id: jti,
      subjectType: "user",
      subjectId: user.id,
      tenantId: user.tenantId,
      expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
    });
    store.clear();
    store.set(
      role === "collector" ? "bik-collector-session" : "bik-admin-session",
      await new SignJWT({
        userId: user.id,
        email: user.email,
        fullName: role === "admin" ? "Test Admin" : "Test Collector",
        role,
        modules: ["susu"],
        tokenVersion: 0,
        jti,
        iat: now,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now)
        .setExpirationTime("1h")
        .sign(JWT_SECRET)
    );
  };
}

export async function createTenantWithBranch(name = "Test Branch") {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `T-${randomBytes(3).toString("hex").toUpperCase()}`,
      name: "Test Tenant",
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const branch = await prisma.location.create({
    data: {
      tenantId: tenant.id,
      name,
      code: `BR-${randomBytes(3).toString("hex").toUpperCase()}`,
      status: "active",
    },
  });
  const admin = await prisma.user.create({
    data: {
      email: `admin-${randomBytes(4).toString("hex")}@bikprestige.test`,
      fullName: "Test Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
      tenantId: tenant.id,
    },
  });
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });
  return { tenant, branch, admin };
}

export async function createBranch(tenantId: string, name: string) {
  return prisma.location.create({
    data: {
      tenantId,
      name,
      code: `BR-${randomBytes(3).toString("hex").toUpperCase()}`,
      status: "active",
    },
  });
}

export async function createAdminInTenant(
  tenantId: string,
  options: { branchId?: string; role?: "branch_manager" | "finance"; fullName?: string } = {}
) {
  const user = await prisma.user.create({
    data: {
      email: `admin-${randomBytes(4).toString("hex")}@bikprestige.test`,
      fullName: options.fullName ?? "Second Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
      tenantId,
    },
  });
  if (options.branchId && options.role) {
    await prisma.branchMembership.create({
      data: {
        tenantId,
        userId: user.id,
        locationId: options.branchId,
        role: options.role,
        status: "active",
      },
    });
  }
  return user;
}

export async function createCollector(tenantId: string, branchId: string, name = "Test Collector") {
  const user = await prisma.user.create({
    data: {
      email: `coll-${randomBytes(4).toString("hex")}@bikprestige.test`,
      fullName: name,
      role: "collector",
      status: "active",
      passwordHash: "x",
      susuEnabled: true,
      tenantId,
      locationId: branchId,
    },
  });
  const collector = await prisma.collector.create({
    data: { tenantId, userId: user.id, status: "active", branchId },
  });
  return { ...collector, user };
}

export async function createAccount(
  tenantId: string,
  adminId: string,
  collectorId: string,
  dailyContribution = 50
) {
  const customer = await prisma.customer.create({
    data: {
      customerId: `BIK-C-${randomBytes(4).toString("hex")}`,
      fullName: "Test Customer",
      status: "active",
      tenantId,
    },
  });
  const account = await prisma.susuAccount.create({
    data: {
      accountId: `BIK-S-${randomBytes(4).toString("hex")}`,
      customerId: customer.id,
      dailyContribution,
      status: "active",
      cardCustody: "customer",
      tenantId,
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date(),
      endDate: new Date(Date.now() + 86_400_000 * 31),
      dailyContribution,
      status: "active",
      commissionCharged: false,
      tenantId,
    },
  });
  const assignment = await prisma.collectorCustomerAssignment.create({
    data: {
      tenantId,
      collectorId,
      customerId: customer.id,
      accountId: account.id,
      active: true,
      activeAccountKey: account.id,
    },
  });
  return { customer, account, cycle, assignment };
}

export async function recordContribution(
  tenantId: string,
  adminId: string,
  collectorId: string,
  accountId: string,
  cycleId: string,
  amount: number,
  options: { collectionDate?: Date; referenceId?: string } = {}
) {
  const referenceId = options.referenceId ?? `CON-${randomBytes(8).toString("hex")}`;
  const collector = await prisma.collector.findUnique({
    where: { id: collectorId },
    select: { branchId: true },
  });
  const contribution = await prisma.contribution.create({
    data: {
      tenantId,
      branchId: collector?.branchId ?? null,
      accountId,
      cycleId,
      amount,
      collectionDate: options.collectionDate ?? new Date(),
      channel: "collector",
      collectorId,
      recordedById: adminId,
      referenceId,
    },
  });
  const cycle = await prisma.susuCycle.findUniqueOrThrow({ where: { id: cycleId } });
  const dailyContribution = money(cycle.dailyContribution);
  const daysCovered = Math.floor(amount / dailyContribution);
  const existing = await prisma.contributionAllocation.findMany({
    where: { contribution: { cycleId } },
    select: { cycleDay: true },
  });
  const paidDays = new Set(existing.map((a) => a.cycleDay));
  const allocations: { contributionId: string; cycleDay: number; amount: number }[] = [];
  let allocated = 0;
  for (let day = 1; day <= 31 && allocated < daysCovered; day += 1) {
    if (paidDays.has(day)) continue;
    allocations.push({ contributionId: contribution.id, cycleDay: day, amount: dailyContribution });
    allocated += 1;
  }
  if (allocations.length > 0) {
    await prisma.contributionAllocation.createMany({ data: allocations });
  }
  return contribution;
}

export function todayUtc(): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export async function openSession(params: {
  type: string;
  branchId?: string | null;
  collectorId?: string | null;
  periodStart?: Date;
  periodEnd?: Date;
}) {
  return openReconciliationSession({
    type: params.type,
    branchId: params.branchId ?? null,
    collectorId: params.collectorId ?? null,
    periodStart: params.periodStart ?? todayUtc(),
    periodEnd: params.periodEnd ?? todayUtc(),
  });
}

export async function sessionLines(sessionId: string) {
  const result = await getReconciliationSession(sessionId);
  if (!result?.success || !result.data) {
    throw new Error(result?.error ?? "Session not found");
  }
  const lines = result.data.lines;
  const latest = new Map<string, (typeof lines)[number]>();
  for (const line of lines) {
    const current = latest.get(line.fingerprint);
    if (!current || line.revision > current.revision) latest.set(line.fingerprint, line);
  }
  return { session: result.data, lines: [...latest.values()] };
}

export async function runSession(sessionId: string) {
  const result = await reconcileSession(sessionId);
  if (!result.success || !result.data) throw new Error(result.error ?? "Reconcile failed");
  return result.data;
}

export async function openCase(params: Parameters<typeof openExceptionCase>[0]) {
  const result = await openExceptionCase(params);
  if (!result.success || !result.data) throw new Error(result.error ?? "Case not opened");
  return result.data;
}

export async function caseView(caseId: string): Promise<ExceptionCaseView> {
  const result = await getExceptionCase(caseId);
  if (!result?.success || !result.data) throw new Error(result?.error ?? "Case not found");
  return result.data;
}
