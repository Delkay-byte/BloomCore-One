/**
 * MaaCash improvements: simplified MoMo closing, one customer Account Number,
 * phone/Account Number customer login, and dual-role staff identity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import {
  prisma,
  cleanDatabase,
  createTestAdmin,
  createTestTenant,
} from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  createDailyAccount,
  saveDailyAccount,
  submitDailyAccount,
} from "@/lib/actions/daily-account.actions";
import { parseReconciliationStatus } from "@/lib/momo-reconciliation";
import { createCustomer } from "@/lib/actions/susu-customer.actions";
import { setStaffModuleCapability } from "@/lib/actions/staff.actions";
import { resolveCustomerAuth } from "@/lib/actions/auth.actions";
import { SHARED_PHONE_MESSAGE } from "@/lib/customer-identifiers";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const PASSWORD = "Test1234!";

async function setSession(
  module: "admin" | "momo",
  user: { id: string; email: string }
) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  const cookie = module === "admin" ? "bik-admin-session" : "bik-worker-session";
  mockCookieStore.set(
    cookie,
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: module === "admin" ? "admin" : "worker",
      modules: module === "admin" ? ["momo", "susu"] : ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

function dailyForm(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

beforeEach(async () => {
  await cleanDatabase();
  mockCookieStore.clear();
});

describe("simplified MoMo daily closing persistence", () => {
  it("saves and submits the approved fields with debts collected", async () => {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Shop", code: "SHOP-1" },
    });
    const agent = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `agent-${Date.now()}@test.invalid`,
        fullName: "Agent",
        role: "worker",
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setSession("momo", agent);

    const created = await createDailyAccount(location.id, "2026-11-09");
    expect(created.success).toBe(true);
    const id = (created.data as { id: string }).id;

    const saved = await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "500",
        openingMomoFloat: "1000",
        closingCash: "600",
        closingMomoFloat: "970",
        // A forged aggregate must be ignored; the rows below total GH₵50.
        totalExpenses: "999",
        expenses: JSON.stringify([
          { description: "Transport", amount: 30 },
          { description: "Food", amount: 20 },
        ]),
        commission: "20",
        debtsCollected: "100",
      })
    );
    expect(saved.success).toBe(true);

    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    expect(Number(row.debtsCollected)).toBe(100);
    expect(Number(row.totalCashIn)).toBe(0);
    expect(Number(row.totalCashOut)).toBe(0);
    expect(Number(row.totalAirtimeSold)).toBe(0);
    expect(Number(row.totalExpenses)).toBe(50);
    expect(Number(row.calculatedDifference)).toBe(0);
    expect(parseReconciliationStatus(row.differenceStatus).status).toBe("balanced");

    const submitted = await submitDailyAccount(id);
    expect(submitted.success).toBe(true);
  });

  it("requires an explanation for a shortage, not for a positive difference", async () => {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Shop 2", code: "SHOP-2" },
    });
    const agent = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `agent2-${Date.now()}@test.invalid`,
        fullName: "Agent 2",
        role: "worker",
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setSession("momo", agent);

    const created = await createDailyAccount(location.id, "2026-11-10");
    const id = (created.data as { id: string }).id;
    await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "200",
        closingCash: "100",
        closingMomoFloat: "175",
        totalExpenses: "0",
        commission: "0",
        debtsCollected: "0",
      })
    );
    const blocked = await submitDailyAccount(id);
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("shortage");

    await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "200",
        closingCash: "100",
        closingMomoFloat: "175",
        totalExpenses: "0",
        commission: "0",
        debtsCollected: "0",
        reconciliationNote: "Cash count was short by GH₵25.",
      })
    );
    expect((await submitDailyAccount(id)).success).toBe(true);

    const createdPositive = await createDailyAccount(location.id, "2026-11-11");
    const positiveId = (createdPositive.data as { id: string }).id;
    await saveDailyAccount(
      positiveId,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "200",
        closingCash: "110",
        closingMomoFloat: "200",
        totalExpenses: "0",
        commission: "0",
        debtsCollected: "0",
      })
    );
    const positive = await submitDailyAccount(positiveId);
    expect(positive.success).toBe(true);
    const positiveRow = await prisma.dailyAccount.findUniqueOrThrow({
      where: { id: positiveId },
    });
    expect(parseReconciliationStatus(positiveRow.differenceStatus).status).toBe("positive");
  });

  it("derives Expenses from the rows, ignores blank rows and rejects incomplete rows", async () => {
    const tenant = await createTestTenant({ momo: true, susu: false });
    const location = await prisma.location.create({
      data: { tenantId: tenant.id, name: "Shop 3", code: "SHOP-3" },
    });
    const agent = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: `agent3-${Date.now()}@test.invalid`,
        fullName: "Agent 3",
        role: "worker",
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setSession("momo", agent);

    const created = await createDailyAccount(location.id, "2026-11-12");
    const id = (created.data as { id: string }).id;

    const saved = await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "100",
        closingCash: "90",
        closingMomoFloat: "100",
        // Client aggregate is deliberately wrong.
        totalExpenses: "500",
        commission: "0",
        debtsCollected: "0",
        expenses: JSON.stringify([
          { description: "", amount: 0 },
          { description: "Transport", amount: 10 },
          { description: "Food", amount: 5 },
        ]),
      })
    );
    expect(saved.success).toBe(true);

    const row = await prisma.dailyAccount.findUniqueOrThrow({ where: { id } });
    expect(Number(row.totalExpenses)).toBe(15);
    const lines = await prisma.expense.findMany({ where: { dailyAccountId: id } });
    expect(lines).toHaveLength(2);

    const amountOnly = await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "100",
        closingCash: "90",
        closingMomoFloat: "100",
        commission: "0",
        debtsCollected: "0",
        expenses: JSON.stringify([{ description: "", amount: 10 }]),
      })
    );
    expect(amountOnly.success).toBe(false);
    expect(amountOnly.error).toContain("description");

    const descriptionOnly = await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "100",
        closingCash: "90",
        closingMomoFloat: "100",
        commission: "0",
        debtsCollected: "0",
        expenses: JSON.stringify([{ description: "Transport", amount: 0 }]),
      })
    );
    expect(descriptionOnly.success).toBe(false);
    expect(descriptionOnly.error).toContain("amount");

    const tooPrecise = await saveDailyAccount(
      id,
      dailyForm({
        openingCash: "100",
        openingMomoFloat: "100",
        closingCash: "90",
        closingMomoFloat: "100",
        commission: "0",
        debtsCollected: "0",
        expenses: JSON.stringify([{ description: "Transport", amount: 10.001 }]),
      })
    );
    expect(tooPrecise.success).toBe(false);
    expect(tooPrecise.error).toContain("two decimal");
  });
});

describe("one customer Account Number", () => {
  it("generates unique server-side Account Numbers and returns the same value", async () => {
    const admin = await createTestAdmin({ susu: true, momo: true });
    await setSession("admin", admin);

    const makeForm = (name: string) => {
      const form = new FormData();
      form.set("fullName", name);
      form.set("phone", "+233240000100");
      form.set("dailyContribution", "50");
      form.set("cardFee", "10");
      return form;
    };

    const first = await createCustomer(makeForm("First Customer"));
    const second = await createCustomer(makeForm("Second Customer"));
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const firstData = first.data as {
      accountNumber: string;
      customer: { customerId: string };
    };
    const secondData = second.data as {
      accountNumber: string;
      customer: { customerId: string };
    };
    expect(firstData.accountNumber).toBe(firstData.customer.customerId);
    expect(secondData.accountNumber).toBe(secondData.customer.customerId);
    expect(firstData.accountNumber).not.toBe(secondData.accountNumber);
    expect(firstData.accountNumber).toMatch(/^BIK-C-/);
  });

  it("keeps Account Numbers unique under concurrent creation", async () => {
    const admin = await createTestAdmin({ susu: true, momo: true });
    await setSession("admin", admin);

    const makeForm = (name: string) => {
      const form = new FormData();
      form.set("fullName", name);
      form.set("dailyContribution", "25");
      return form;
    };

    const results = await Promise.all([
      createCustomer(makeForm("Concurrent A")),
      createCustomer(makeForm("Concurrent B")),
      createCustomer(makeForm("Concurrent C")),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    const rows = await prisma.customer.findMany({
      where: { tenantId: admin.tenantId ?? undefined },
      select: { customerId: true },
    });
    expect(new Set(rows.map((row) => row.customerId)).size).toBe(rows.length);
  });
});

describe("customer login by phone or Account Number", () => {
  async function customer(
    customerId: string,
    phone: string,
    options: { portal?: boolean } = {}
  ) {
    return prisma.customer.create({
      data: {
        customerId,
        fullName: `Customer ${customerId}`,
        phone,
        status: "active",
        portalEnabled: options.portal ?? true,
        portalPasswordHash: await bcrypt.hash(PASSWORD, 4),
      },
    });
  }

  it("signs in with the canonical Account Number", async () => {
    const row = await customer("BIK-C-900001", "+233240000201");
    const result = await resolveCustomerAuth(row.customerId, PASSWORD);
    expect("payload" in result).toBe(true);
  });

  it("signs in with a normalized Ghanaian phone number", async () => {
    await customer("BIK-C-900002", "+233240000202");
    const result = await resolveCustomerAuth("0240000202", PASSWORD);
    expect("payload" in result).toBe(true);
  });

  it("refuses to choose one of several accounts sharing a phone", async () => {
    await customer("BIK-C-900003", "+233240000203");
    await customer("BIK-C-900004", "+233240000203");
    const result = await resolveCustomerAuth("0240000203", PASSWORD);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toBe(SHARED_PHONE_MESSAGE);
  });

  it("rejects an email identifier", async () => {
    const row = await customer("BIK-C-900005", "+233240000205");
    await prisma.customer.update({
      where: { id: row.id },
      data: { email: "customer@example.com" },
    });
    const result = await resolveCustomerAuth("customer@example.com", PASSWORD);
    expect("error" in result).toBe(true);
  });

  it("rejects a disabled portal even with the correct password", async () => {
    const row = await customer("BIK-C-900006", "+233240000206", {
      portal: false,
    });
    const result = await resolveCustomerAuth(row.customerId, PASSWORD);
    expect("error" in result).toBe(true);
  });
});

describe("dual-role staff identity", () => {
  it("promotes a MoMo agent to Susu on the same identity and password", async () => {
    const admin = await createTestAdmin({ susu: true, momo: true });
    const location = await prisma.location.create({
      data: {
        tenantId: admin.tenantId!,
        name: "Dual Shop",
        code: "DUAL-1",
      },
    });
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const agent = await prisma.user.create({
      data: {
        tenantId: admin.tenantId,
        email: `dual-${Date.now()}@test.invalid`,
        fullName: "Dual Person",
        role: "worker",
        passwordHash,
        momoEnabled: true,
        locationId: location.id,
      },
    });
    await setSession("admin", admin);

    const promoted = await setStaffModuleCapability(agent.id, "susu", true);
    expect(promoted.success).toBe(true);

    const same = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    expect(same.passwordHash).toBe(passwordHash);
    expect(same.momoEnabled).toBe(true);
    expect(same.susuEnabled).toBe(true);
    expect(same.locationId).toBe(location.id);
    const collector = await prisma.collector.findUnique({
      where: { userId: agent.id },
    });
    expect(collector?.status).toBe("active");

    const disabled = await setStaffModuleCapability(agent.id, "susu", false);
    expect(disabled.success).toBe(true);
    const stillOne = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stillOne.momoEnabled).toBe(true);
    expect(stillOne.susuEnabled).toBe(false);
    expect(stillOne.passwordHash).toBe(passwordHash);
    const inactive = await prisma.collector.findUnique({
      where: { userId: agent.id },
    });
    expect(inactive?.status).toBe("inactive");
    expect(await prisma.user.count({ where: { id: agent.id } })).toBe(1);
  });
});
