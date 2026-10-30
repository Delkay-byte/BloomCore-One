/* eslint-disable @typescript-eslint/no-explicit-any -- test assertions read untyped action payloads */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import { isSessionCurrent } from "@/lib/auth";
import { normalizeGhanaPhone } from "@/lib/utils";

beforeEach(async () => {
  await cleanDatabase();
});

const now = () => Math.floor(Date.now() / 1000);
const customerPayload = (id: string, tokenVersion: number) =>
  ({
    userId: id,
    role: "customer",
    iat: now(),
    tokenVersion,
  } as any);

describe("normalizeGhanaPhone", () => {
  it("treats 024... and +233... as equivalent forms", () => {
    expect(normalizeGhanaPhone("0241234567")).toEqual([
      "0241234567",
      "233241234567",
      "+233241234567",
    ]);
  });

  it("handles +233 prefixed input", () => {
    expect(normalizeGhanaPhone("+233241234567")).toEqual([
      "0241234567",
      "233241234567",
      "+233241234567",
    ]);
  });

  it("handles 233 prefixed input without plus", () => {
    expect(normalizeGhanaPhone("233241234567")).toEqual([
      "0241234567",
      "233241234567",
      "+233241234567",
    ]);
  });

  it("returns empty for blanks", () => {
    expect(normalizeGhanaPhone("")).toEqual([]);
    expect(normalizeGhanaPhone("   ")).toEqual([]);
  });
});

describe("customer session validation (isSessionCurrent)", () => {
  async function seedPortalCustomer(overrides: Record<string, unknown> = {}) {
    return prisma.customer.create({
      data: {
        customerId: "BIK-C-PROV-1",
        fullName: "Provision Test",
        phone: "+233241234567",
        email: "prov@test.com",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: "hashed",
        tokenVersion: 0,
        ...overrides,
      },
    });
  }

  it("returns true for an active customer with matching tokenVersion", async () => {
    const c = await seedPortalCustomer();
    expect(await isSessionCurrent(customerPayload(c.id, 0))).toBe(true);
  });

  it("returns false when tokenVersion mismatches (session invalidated)", async () => {
    const c = await seedPortalCustomer();
    expect(await isSessionCurrent(customerPayload(c.id, 5))).toBe(false);
  });

  it("returns false for an inactive customer", async () => {
    const c = await seedPortalCustomer({ status: "inactive" });
    expect(await isSessionCurrent(customerPayload(c.id, 0))).toBe(false);
  });

  it("bumping tokenVersion invalidates an existing session", async () => {
    const c = await seedPortalCustomer();
    expect(await isSessionCurrent(customerPayload(c.id, 0))).toBe(true);

    await prisma.customer.update({
      where: { id: c.id },
      data: { tokenVersion: { increment: 1 } },
    });

    expect(await isSessionCurrent(customerPayload(c.id, 0))).toBe(false);
  });
});

describe("customer login identifier resolution", () => {
  it("resolves a +233 phone from a 024 local number via normalization", async () => {
    await prisma.customer.create({
      data: {
        customerId: "BIK-C-PROV-2",
        fullName: "Phone Match",
        phone: "+233241234567",
        status: "active",
        portalEnabled: true,
        portalPasswordHash: "hashed",
        tokenVersion: 0,
      },
    });

    const candidates = normalizeGhanaPhone("0241234567");
    const found = await prisma.customer.findFirst({
      where: {
        portalEnabled: true,
        OR: [
          { customerId: "0241234567" },
          { email: "0241234567" },
          { phone: "0241234567" },
          { phone: { in: candidates } },
        ],
      },
    });
    expect(found).not.toBeNull();
    expect(found?.phone).toBe("+233241234567");
  });
});
