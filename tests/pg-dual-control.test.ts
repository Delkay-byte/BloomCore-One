/**
 * Residual E PostgreSQL concurrency proof.
 *
 * A maker-checker approval authorizes exactly one financial posting, even when
 * two administrators' requests try to consume the same approval at the same
 * time. The conditional update is the gate: exactly one transaction can move
 * the row from `approved` to `consumed`.
 *
 * Run with:
 *   PG_DATABASE_URL=... PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE \
 *     npx vitest run --config vitest.pg.config.ts
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";
import { db } from "@/lib/db";
import { consumeFinancialApproval } from "@/lib/security/dual-control";

const ACTION = "susu.contribution.reverse" as const;

async function seedApproved(overrides: { approvedBy?: string; targetId?: string } = {}) {
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PG-DC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: "PG Dual Control",
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const approval = await prisma.financialApproval.create({
    data: {
      tenantId: tenant.id,
      action: ACTION,
      targetType: "contribution",
      targetId: overrides.targetId ?? "pg-contribution-1",
      amountMinor: 20000,
      reason: "Concurrency probe for maker-checker consumption",
      requestedBy: "maker-admin",
      status: "approved",
      approvedBy: overrides.approvedBy ?? "approver-admin",
      decidedAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return { tenant, approval };
}

beforeEach(async () => {
  await cleanDatabase();
});

describe("financial approval consumption on PostgreSQL", () => {
  it("consumes an approved request exactly once under concurrent claims", async () => {
    const { tenant, approval } = await seedApproved();
    const ctx = {
      tenantId: tenant.id,
      action: ACTION,
      targetId: approval.targetId,
      requesterId: "approver-admin",
    };

    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        db.$transaction((tx) => consumeFinancialApproval(tx, approval.id, ctx))
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);

    const stored = await prisma.financialApproval.findUnique({
      where: { id: approval.id },
    });
    expect(stored?.status).toBe("consumed");
  });

  it("refuses an approval bound to a different target or a different approver", async () => {
    const { tenant, approval } = await seedApproved();

    const wrongTarget = await db.$transaction((tx) =>
      consumeFinancialApproval(tx, approval.id, {
        tenantId: tenant.id,
        action: ACTION,
        targetId: "a-different-contribution",
        requesterId: "approver-admin",
      })
    );
    expect(wrongTarget).toBe(false);

    const wrongApprover = await db.$transaction((tx) =>
      consumeFinancialApproval(tx, approval.id, {
        tenantId: tenant.id,
        action: ACTION,
        targetId: approval.targetId,
        requesterId: "someone-else",
      })
    );
    expect(wrongApprover).toBe(false);

    const stored = await prisma.financialApproval.findUnique({
      where: { id: approval.id },
    });
    expect(stored?.status).toBe("approved");
  });

  it("refuses an expired approval", async () => {
    const { tenant, approval } = await seedApproved();
    await prisma.financialApproval.update({
      where: { id: approval.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await db.$transaction((tx) =>
      consumeFinancialApproval(tx, approval.id, {
        tenantId: tenant.id,
        action: ACTION,
        targetId: approval.targetId,
        requesterId: "approver-admin",
      })
    );
    expect(result).toBe(false);
  });
});
