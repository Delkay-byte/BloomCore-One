/**
 * Phase 7 on PostgreSQL.
 *
 * The SQLite suite proves the rules. These tests run the same actions against a
 * disposable PostgreSQL database so the parts that only a real server can prove
 * are covered: the JSON columns, the Decimal amount round trip, the batch
 * uniqueness constraint on (tenantId, fileHash), the row uniqueness on
 * (batchId, rowNumber) and the transactional commit that has to survive real
 * concurrent statements.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { createSessionRecord } from "@/lib/security/session-store";
import { prisma, cleanDatabase } from "./pg-setup";
import {
  createImportBatch,
  validateImportBatch,
  resolveImportRows,
  getImportPreview,
  confirmImportBatch,
  getImportBatches,
  getImportErrorReport,
} from "@/lib/actions/susu-import.actions";
import {
  registerCustomerOnboarding,
  addAccountToCustomerOnboarding,
} from "@/lib/actions/susu-onboarding.actions";

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

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function asAdmin(user: { id: string; tenantId: string | null; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  if (!user.tenantId) throw new Error("test user has no tenant");
  const jti = `pgp7-${now}-${Math.random().toString(16).slice(2)}`;
  await createSessionRecord({
    id: jti,
    subjectType: "user",
    subjectId: user.id,
    tenantId: user.tenantId,
    expiresAt: new Date(now * 1000 + 60 * 60 * 1000),
  });
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "PG Admin",
      role: "admin",
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
}

async function fixture(label: string) {
  const suffix = randomBytes(4).toString("hex");
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `PGP7-${suffix.toUpperCase()}`,
      name: `PG Phase 7 ${label} ${suffix}`,
      momoEnabled: true,
      susuEnabled: true,
      status: "ACTIVE",
      onboardingStatus: "COMPLETED",
    },
  });
  const branch = await prisma.location.create({
    data: { tenantId: tenant.id, name: "Accra Main", code: `PGA-${suffix}`, status: "active" },
  });
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `pgp7-${suffix}-admin@test.local`,
      fullName: "PG Admin",
      role: "admin",
      status: "active",
      passwordHash: "not-used",
      momoEnabled: true,
      susuEnabled: true,
    },
  });
  await prisma.businessTenant.update({
    where: { id: tenant.id },
    data: { primaryAdminUserId: admin.id },
  });
  return { tenant, branch, admin };
}

function uploadForm(text: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("name", "PostgreSQL migration");
  form.set("file", new File([text], "register.csv", { type: "text/csv" }));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const REGISTER =
  "Full name,Phone,Daily contribution,Customer reference,Opening date\n" +
  "Ama Boateng,0244777888,50.25,PB-100,2024-05-06\n" +
  "Kojo Antwi,0244999888,20,PB-101,\n";

describe("Phase 7 on PostgreSQL", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("commits an import transactionally and preserves amounts and dates", async () => {
    const { tenant, branch, admin } = await fixture("commit");
    await asAdmin(admin);

    const staged = await createImportBatch(
      uploadForm(REGISTER, { branchId: branch.id })
    );
    expect(staged.success).toBe(true);
    const batchId = (staged.data as { batchId: string }).batchId;

    // The unique (tenantId, fileHash) constraint is what makes a re-upload resume
    // the same batch instead of duplicating it on a second server.
    const again = await createImportBatch(
      uploadForm(REGISTER, { branchId: branch.id })
    );
    expect((again.data as { batchId: string }).batchId).toBe(batchId);
    expect(await prisma.customerImportBatch.count({ where: { tenantId: tenant.id } })).toBe(1);

    const validated = await validateImportBatch({ batchId });
    expect(validated.success).toBe(true);

    const preview = await getImportPreview({ batchId });
    const plan = preview.data as { planHash: string; ready: boolean };
    expect(plan.ready).toBe(true);

    const committed = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success).toBe(true);
    expect((committed.data as { status: string }).status).toBe("committed");

    const accounts = await prisma.susuAccount.findMany({
      where: { tenantId: tenant.id },
      include: { customer: true, cycles: true },
      orderBy: { accountId: "asc" },
    });
    expect(accounts).toHaveLength(2);
    const ama = accounts.find((account) => account.customer.fullName === "Ama Boateng")!;
    expect(Number(ama.dailyContribution)).toBe(50.25);
    expect(ama.branchId).toBe(branch.id);
    expect(ama.openingDate!.toISOString().slice(0, 10)).toBe("2024-05-06");
    expect(ama.cycles).toHaveLength(1);

    const kojo = accounts.find((account) => account.customer.fullName === "Kojo Antwi")!;
    expect(Number(kojo.dailyContribution)).toBe(20);
    // The file left the opening date blank. An unknown date stays unknown
    // instead of being filled in with the day of the import.
    expect(kojo.openingDate).toBeNull();

    // A migration never moves money.
    expect(await prisma.contribution.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.withdrawal.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.commission.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.cardFee.count({ where: { tenantId: tenant.id } })).toBe(0);

    const batch = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(batch!.status).toBe("committed");
    expect(batch!.committedAt).not.toBeNull();
    // The staged source text is cleared once the batch is done.
    expect(batch!.sourceText).toBeNull();

    const rows = await prisma.customerImportRow.findMany({
      where: { batchId },
      orderBy: { rowNumber: "asc" },
    });
    // A fresh person imports as "imported"; a new account for a known person is
    // "linked". Both rows here are new people.
    expect(rows.map((row) => row.outcome)).toEqual(["imported", "imported"]);
    expect(rows.every((row) => row.committedAt !== null)).toBe(true);

    const history = await getImportBatches();
    expect((history.data as { batches: unknown[] }).batches).toHaveLength(1);

    const report = await getImportErrorReport({ batchId });
    expect((report.data as { rowCount: number }).rowCount).toBe(0);
  });

  it("holds a commit until a flagged row is decided, then applies the decision", async () => {
    const { tenant, branch, admin } = await fixture("review");
    await asAdmin(admin);

    const text =
      "Full name,Phone,Daily contribution\n" +
      "Ama Boateng,0244777888,50\n" +
      "Yaa Asantewaa,0244777888,20\n";
    const staged = await createImportBatch(uploadForm(text, { branchId: branch.id }));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });

    const batch = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(batch!.reviewRows).toBe(1);
    expect(batch!.status).toBe("validated");

    const blockedPlan = (await getImportPreview({ batchId })).data as {
      planHash: string;
    };
    const blocked = await confirmImportBatch({
      batchId,
      planHash: blockedPlan.planHash,
      confirmText: "IMPORT",
    });
    expect(blocked.success).toBe(false);
    expect(await prisma.customer.count({ where: { tenantId: tenant.id } })).toBe(0);

    const decided = await resolveImportRows({
      batchId,
      resolutions: [{ rowNumber: 2, resolution: "create_new", note: "Sister, shared phone" }],
    });
    expect(decided.success).toBe(true);

    const { planHash } = (await getImportPreview({ batchId })).data as { planHash: string };
    const committed = await confirmImportBatch({ batchId, planHash, confirmText: "IMPORT" });
    expect(committed.success).toBe(true);
    expect(await prisma.customer.count({ where: { tenantId: tenant.id } })).toBe(2);

    const errorReport = await getImportErrorReport({ batchId });
    expect((errorReport.data as { rowCount: number }).rowCount).toBe(0);
  });

  it("rejects a stale plan digest after a decision changed the plan", async () => {
    const { branch, admin } = await fixture("stale");
    await asAdmin(admin);

    const text =
      "Full name,Phone,Daily contribution\n" +
      "Ama Boateng,0244777888,50\n" +
      "Yaa Asantewaa,0244777888,20\n";
    const staged = await createImportBatch(uploadForm(text, { branchId: branch.id }));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });
    const before = (await getImportPreview({ batchId })).data as { planHash: string };

    await resolveImportRows({
      batchId,
      resolutions: [{ rowNumber: 2, resolution: "exclude" }],
    });

    const stale = await confirmImportBatch({
      batchId,
      planHash: before.planHash,
      confirmText: "IMPORT",
    });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain("changed");

    const after = (await getImportPreview({ batchId })).data as { planHash: string };
    expect(after.planHash).not.toBe(before.planHash);
    const committed = await confirmImportBatch({
      batchId,
      planHash: after.planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success).toBe(true);
    expect((committed.data as { skippedRows: number }).skippedRows).toBe(1);
  });

  it("registers a person once and opens a second account for them", async () => {
    const { tenant, branch, admin } = await fixture("onboarding");
    await asAdmin(admin);

    const first = new FormData();
    first.set("fullName", "Akosua Frimpong");
    first.set("phone", "0244111222");
    first.set("dailyContribution", "30");
    first.set("branchId", branch.id);
    const created = await registerCustomerOnboarding(first);
    expect(created.success).toBe(true);
    const data = created.data as { customer: { id: string; customerId: string } };

    const second = new FormData();
    second.set("customerId", data.customer.id);
    second.set("dailyContribution", "50");
    second.set("branchId", branch.id);
    const added = await addAccountToCustomerOnboarding(second);
    expect(added.success).toBe(true);

    expect(await prisma.customer.count({ where: { tenantId: tenant.id } })).toBe(1);
    const accounts = await prisma.susuAccount.findMany({
      where: { tenantId: tenant.id },
      include: { cycles: true },
    });
    expect(accounts).toHaveLength(2);
    expect(accounts.every((account) => account.branchId === branch.id)).toBe(true);
    expect(accounts.every((account) => account.cycles.length === 1)).toBe(true);
    expect(await prisma.contribution.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("keeps one tenant's import invisible to another tenant", async () => {
    const first = await fixture("owner");
    await asAdmin(first.admin);
    const staged = await createImportBatch(
      uploadForm(REGISTER, { branchId: first.branch.id })
    );
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });

    const intruder = await fixture("intruder");
    await asAdmin(intruder.admin);

    const preview = await getImportPreview({ batchId });
    expect(preview.success).toBe(false);
    const commit = await confirmImportBatch({
      batchId,
      planHash: "0".repeat(64),
      confirmText: "IMPORT",
    });
    expect(commit.success).toBe(false);
    expect(await prisma.customer.count({ where: { tenantId: intruder.tenant.id } })).toBe(0);
  });
});
