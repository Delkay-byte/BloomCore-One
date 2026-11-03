import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import { beginMfaEnrollment, confirmMfaEnrollment, verifyMfaCode } from "@/lib/security/mfa";
import { totpCode } from "@/lib/security/totp";

const STEP = 30_000;

function alignedNow(): number {
  return Math.floor(Date.now() / STEP) * STEP + 5_000;
}

async function enrolledUser(email: string) {
  const user = await prisma.user.create({
    data: {
      email,
      fullName: "TOTP Test User",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const started = await beginMfaEnrollment({
    subjectType: "user",
    subjectId: user.id,
    accountName: email,
  });
  const confirmed = await confirmMfaEnrollment({
    subjectType: "user",
    subjectId: user.id,
    code: totpCode(started.secret),
  });
  if (!confirmed) throw new Error("enrolment failed");
  return { user, secret: started.secret, recoveryCodes: confirmed.recoveryCodes };
}

describe("TOTP replay prevention", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("accepts a valid current code once", async () => {
    const { user, secret } = await enrolledUser("totp-valid@test.local");
    const now = alignedNow();
    const first = await verifyMfaCode({
      subjectType: "user",
      subjectId: user.id,
      code: totpCode(secret, now),
      now,
    });
    expect(first.ok).toBe(true);
    expect(first.usedRecoveryCode).toBe(false);
  });

  it("rejects the same time step on a second attempt", async () => {
    const { user, secret } = await enrolledUser("totp-replay@test.local");
    const now = alignedNow();
    const code = totpCode(secret, now);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code, now })).ok
    ).toBe(true);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code, now })).ok
    ).toBe(false);
  });

  it("accepts the next time step and rejects an older one afterwards", async () => {
    const { user, secret } = await enrolledUser("totp-next@test.local");
    const now = alignedNow();
    const oldCode = totpCode(secret, now);
    const nextNow = now + STEP;
    const nextCode = totpCode(secret, nextNow);

    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: oldCode, now })).ok
    ).toBe(true);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: nextCode, now: nextNow })).ok
    ).toBe(true);
    // The ±1 drift window would otherwise still accept the older step.
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: oldCode, now })).ok
    ).toBe(false);
  });

  it("allows the configured clock-drift window before any newer step is used", async () => {
    const { user, secret } = await enrolledUser("totp-drift@test.local");
    const now = alignedNow();
    // A code from the previous step is inside the ±1 window.
    const previous = totpCode(secret, now - STEP);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: previous, now })).ok
    ).toBe(true);
  });

  it("rejects an invalid code without advancing the step", async () => {
    const { user, secret } = await enrolledUser("totp-invalid@test.local");
    const now = alignedNow();
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: "000000", now })).ok
    ).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mfaLastTotpStep).toBeNull();
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: totpCode(secret, now), now })).ok
    ).toBe(true);
  });

  it("keeps recovery-code use working and single-use after TOTP", async () => {
    const { user, secret, recoveryCodes } = await enrolledUser("totp-recovery@test.local");
    const now = alignedNow();
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: user.id, code: totpCode(secret, now), now })).ok
    ).toBe(true);

    const recovery = recoveryCodes[0];
    const first = await verifyMfaCode({
      subjectType: "user",
      subjectId: user.id,
      code: recovery,
      now,
    });
    expect(first.ok).toBe(true);
    expect(first.usedRecoveryCode).toBe(true);

    const replay = await verifyMfaCode({
      subjectType: "user",
      subjectId: user.id,
      code: recovery,
      now,
    });
    expect(replay.ok).toBe(false);
  });

  it("accepts exactly one of two concurrent identical codes", async () => {
    const { user, secret } = await enrolledUser("totp-concurrent@test.local");
    await prisma.user.update({
      where: { id: user.id },
      data: { mfaLastTotpStep: null },
    });
    const now = alignedNow();
    const code = totpCode(secret, now);

    const results = await Promise.all([
      verifyMfaCode({ subjectType: "user", subjectId: user.id, code, now }),
      verifyMfaCode({ subjectType: "user", subjectId: user.id, code, now }),
      verifyMfaCode({ subjectType: "user", subjectId: user.id, code, now }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });
});
