import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanDatabase } from "./pg-setup";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  verifyMfaCode,
} from "@/lib/security/mfa";
import { totpCode } from "@/lib/security/totp";

const STEP = 30_000;
const alignedNow = () => Math.floor(Date.now() / STEP) * STEP + 5_000;

async function user(email: string) {
  const row = await prisma.user.create({
    data: {
      email,
      fullName: "PG TOTP User",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
    },
  });
  const started = await beginMfaEnrollment({
    subjectType: "user",
    subjectId: row.id,
    accountName: email,
  });
  const confirmed = await confirmMfaEnrollment({
    subjectType: "user",
    subjectId: row.id,
    code: totpCode(started.secret),
  });
  if (!confirmed) throw new Error("enrolment failed");
  return { row, secret: started.secret };
}

describe("PostgreSQL TOTP replay prevention", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects reuse of the same accepted step", async () => {
    const { row, secret } = await user(`pg-totp-${Date.now()}@test.local`);
    const now = alignedNow();
    const code = totpCode(secret, now);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: row.id, code, now })).ok
    ).toBe(true);
    expect(
      (await verifyMfaCode({ subjectType: "user", subjectId: row.id, code, now })).ok
    ).toBe(false);
  });

  it("allows only one concurrent acceptance across connections", async () => {
    const { row, secret } = await user(`pg-totp-race-${Date.now()}@test.local`);
    const now = alignedNow();
    const code = totpCode(secret, now);
    const results = await Promise.all([
      verifyMfaCode({ subjectType: "user", subjectId: row.id, code, now }),
      verifyMfaCode({ subjectType: "user", subjectId: row.id, code, now }),
      verifyMfaCode({ subjectType: "user", subjectId: row.id, code, now }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });
});
