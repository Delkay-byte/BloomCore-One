/**
 * SEC-04 PostgreSQL concurrency proof: one step-up grant authorizes exactly one
 * protected operation, even when two requests claim it at the same time.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";
import { db } from "@/lib/db";
import {
  claimStepUpGrant,
  hashStepUpToken,
  stepUpContextHash,
} from "@/lib/security/step-up";

const PURPOSE = "susu.withdrawal" as const;

async function seedGrant(input?: { expiresAt?: Date }) {
  const user = await prisma.user.create({
    data: {
      email: `pg-stepup-${Date.now()}@test.local`,
      fullName: "Step Up",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const raw = `pg-step-up-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const targetType = "susuAccount";
  const targetId = "pg-account-1";
  const context = { amountMinor: "2000", currency: "GHS" };
  const sessionId = `legacy:${user.id}:12345`;

  await prisma.stepUpGrant.create({
    data: {
      tokenHash: hashStepUpToken(raw),
      subjectType: "user",
      subjectId: user.id,
      sessionId,
      purpose: PURPOSE,
      targetType,
      targetId,
      contextHash: stepUpContextHash({
        purpose: PURPOSE,
        targetType,
        targetId,
        context,
      }),
      expiresAt: input?.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return {
    raw,
    user,
    sessionId,
    targetType,
    targetId,
    context,
  };
}

describe("PostgreSQL step-up grant consumption", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("allows exactly one of two concurrent claims", async () => {
    const grant = await seedGrant();
    const claim = () =>
      db.$transaction((tx) =>
        claimStepUpGrant(tx, {
          token: grant.raw,
          subjectType: "user",
          subjectId: grant.user.id,
          sessionId: grant.sessionId,
          purpose: PURPOSE,
          targetType: grant.targetType,
          targetId: grant.targetId,
          context: grant.context,
        })
      );

    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const row = await prisma.stepUpGrant.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
  });

  it("rejects an expired grant", async () => {
    const grant = await seedGrant({ expiresAt: new Date(Date.now() - 1000) });
    const result = await db.$transaction((tx) =>
      claimStepUpGrant(tx, {
        token: grant.raw,
        subjectType: "user",
        subjectId: grant.user.id,
        sessionId: grant.sessionId,
        purpose: PURPOSE,
        targetType: grant.targetType,
        targetId: grant.targetId,
        context: grant.context,
      })
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a changed amount", async () => {
    const grant = await seedGrant();
    const result = await db.$transaction((tx) =>
      claimStepUpGrant(tx, {
        token: grant.raw,
        subjectType: "user",
        subjectId: grant.user.id,
        sessionId: grant.sessionId,
        purpose: PURPOSE,
        targetType: grant.targetType,
        targetId: grant.targetId,
        context: { amountMinor: "1000", currency: "GHS" },
      })
    );
    expect(result.ok).toBe(false);
  });
});
