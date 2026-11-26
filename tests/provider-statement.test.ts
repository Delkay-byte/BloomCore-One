import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin, createTestTenant } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name) ? { name, value: mockCookieStore.get(name)! } : undefined,
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

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test Admin",
      role: "admin",
      modules: ["momo", "susu"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

/**
 * Provider statement import (Priority A1).
 *
 * The importer is evidence-only. These tests prove:
 *   - parsing, mapping, validation and integer-pesewa arithmetic;
 *   - duplicate detection within and across imports;
 *   - matching that never mutates an existing financial record;
 *   - tenant isolation and administrator-only access;
 *   - the file hash prevents the same statement being imported twice.
 */

const HEADER = "Transaction ID,Date,Type,Amount,Fee,Balance,Description";
const CSV = [
  HEADER,
  "MTN-1,2026-11-01 09:15:00,Credit,250.00,1.00,1250.00,Customer deposit",
  "MTN-2,2026-11-01 10:05:00,Debit,100.50,0.50,1149.50,Cash out",
  "MTN-3,2026-11-01 11:30:00,Credit,75.25,0.00,1224.75,Deposit",
].join("\n");

describe("provider statement parsing", () => {
  it("detects a column mapping from real provider headings", async () => {
    const { detectColumnMapping, missingRequiredFields } = await import("@/lib/provider-statement");
    const mapping = detectColumnMapping(HEADER.split(","));
    expect(mapping.transactionAt).toBe(1);
    expect(mapping.direction).toBe(2);
    expect(mapping.amount).toBe(3);
    expect(mapping.externalReference).toBe(0);
    expect(mapping.fee).toBe(4);
    expect(mapping.balanceAfter).toBe(5);
    expect(mapping.description).toBe(6);
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it("parses every row and reports the exact period", async () => {
    const { parseStatement } = await import("@/lib/provider-statement");
    const parsed = parseStatement({ provider: "mtn", csv: CSV });
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.validRows).toBe(3);
    expect(parsed.invalidRows).toBe(0);
    expect(parsed.periodStart?.toISOString()).toBe("2026-11-01T09:15:00.000Z");
    expect(parsed.periodEnd?.toISOString()).toBe("2026-11-01T11:30:00.000Z");
    expect(parsed.rows[0].amountMinor).toBe(25000);
    expect(parsed.rows[1].amountMinor).toBe(10050);
    expect(parsed.rows[1].direction).toBe("out");
  });

  it("keeps integer pesewa and never loses a fraction to floating point", async () => {
    const { parseMoneyToMinor } = await import("@/lib/provider-statement");
    expect(parseMoneyToMinor("0.10")).toEqual({ ok: true, minor: 10 });
    expect(parseMoneyToMinor("0.07")).toEqual({ ok: true, minor: 7 });
    expect(parseMoneyToMinor("1,234.56")).toEqual({ ok: true, minor: 123456 });
    expect(parseMoneyToMinor("GHS 12.00")).toEqual({ ok: true, minor: 1200 });
    expect(parseMoneyToMinor("(12.50)")).toEqual({ ok: true, minor: -1250 });
    // Three decimal places are rejected instead of being silently rounded.
    expect(parseMoneyToMinor("12.005").ok).toBe(false);
    expect(parseMoneyToMinor("abc").ok).toBe(false);
  });

  it("rejects an ambiguous or unknown date instead of guessing", async () => {
    const { parseStatementDate } = await import("@/lib/provider-statement");
    expect(parseStatementDate("2026-11-01").ok).toBe(true);
    expect(parseStatementDate("01/11/2026 09:15").ok).toBe(true);
    expect(parseStatementDate("2026/11/01 09:15").ok).toBe(true);
    expect(parseStatementDate("Nov 1 2026").ok).toBe(false);
    expect(parseStatementDate("").ok).toBe(false);
  });

  it("marks an unparseable row invalid but keeps the rest of the file", async () => {
    const { parseStatement } = await import("@/lib/provider-statement");
    const csv = [
      HEADER,
      "MTN-1,2026-11-01 09:15:00,Credit,250.00,1.00,1250.00,Ok",
      "MTN-2,not-a-date,Credit,10.00,0.00,1260.00,Bad date",
      "MTN-3,2026-11-01 11:30:00,Sideways,10.00,0.00,1270.00,Bad direction",
    ].join("\n");
    const parsed = parseStatement({ provider: "mtn", csv });
    expect(parsed.validRows).toBe(1);
    expect(parsed.invalidRows).toBe(2);
    expect(parsed.rows[1].errors[0]).toMatch(/not a recognised date format/i);
    expect(parsed.rows[2].errors[0]).toMatch(/not a recognised direction/i);
  });

  it("reports a header that cannot satisfy the required fields", async () => {
    const { parseStatement } = await import("@/lib/provider-statement");
    const parsed = parseStatement({ provider: "mtn", csv: "Reference,Notes\nA,B" });
    expect(parsed.errors.join(" ")).toMatch(/missing a column for/i);
  });

  it("counts matched, unmatched, duplicate and invalid rows exactly", async () => {
    const { summariseStatementRows } = await import("@/lib/provider-statement");
    const summary = summariseStatementRows([
      { status: "matched", direction: "in", amountMinor: 10000, matchType: "exact_reference" },
      { status: "unmatched", direction: "out", amountMinor: 4000, matchType: null },
      { status: "duplicate", direction: "in", amountMinor: 10000, matchType: null },
      { status: "invalid", direction: null, amountMinor: null, matchType: null },
    ]);
    expect(summary).toMatchObject({
      totalRows: 4,
      matchedRows: 1,
      unmatchedRows: 1,
      duplicateRows: 1,
      invalidRows: 1,
      matchedInMinor: 10000,
      unmatchedOutMinor: 4000,
      netUnmatchedMinor: -4000,
    });
  });

  it("matches on reference first and falls back to amount plus time", async () => {
    const { findStatementMatch } = await import("@/lib/provider-statement");
    const at = new Date("2026-11-01T09:15:00.000Z");
    const candidates = [
      { id: "t1", reference: "MTN-1", transactionAt: at, direction: "in", amountMinor: 25000 },
      { id: "t2", reference: "OTHER", transactionAt: at, direction: "out", amountMinor: 10050 },
    ];
    expect(
      findStatementMatch(
        { externalReference: "mtn-1", transactionAt: at, direction: "in", amountMinor: 25000 },
        candidates
      )
    ).toEqual({ entityId: "t1", matchType: "exact_reference" });
    expect(
      findStatementMatch(
        {
          externalReference: null,
          transactionAt: new Date(at.getTime() + 4 * 60 * 1000),
          direction: "out",
          amountMinor: 10050,
        },
        candidates
      )
    ).toEqual({ entityId: "t2", matchType: "amount_and_time" });
  });

  it("refuses to guess when a reference is reused for a different amount", async () => {
    const { findStatementMatch } = await import("@/lib/provider-statement");
    const at = new Date("2026-11-01T09:15:00.000Z");
    const candidates = [
      { id: "t1", reference: "MTN-1", transactionAt: at, direction: "in", amountMinor: 25000 },
    ];
    expect(
      findStatementMatch(
        { externalReference: "MTN-1", transactionAt: at, direction: "in", amountMinor: 99900 },
        candidates
      )
    ).toBeNull();
    // Two equally good candidates is ambiguous, so a human decides.
    const duplicated = [...candidates, { ...candidates[0], id: "t2" }];
    expect(
      findStatementMatch(
        { externalReference: null, transactionAt: at, direction: "in", amountMinor: 25000 },
        duplicated
      )
    ).toBeNull();
  });
});

describe("provider statement import action", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedTenantWithDeposit() {
    const admin = await createTestAdmin();
    await setAdminSession(admin);
    const tenantId = admin.tenantId!;
    const location = await prisma.location.create({
      data: { tenantId, name: "Accra", code: `ACC-${Date.now().toString().slice(-6)}` },
    });
    const transaction = await prisma.momoTransaction.create({
      data: {
        tenantId,
        locationId: location.id,
        workerId: admin.id,
        type: "cash_in",
        network: "mtn",
        direction: "inflow",
        amount: 250,
        businessDate: new Date("2026-11-01T00:00:00.000Z"),
        occurredAt: new Date("2026-11-01T09:15:00.000Z"),
        reference: `MOMO-${Date.now()}`,
        externalReference: "MTN-1",
        idempotencyKey: `idem-${Date.now()}`,
        recordedById: admin.id,
      },
    });
    return { admin, tenantId, location, transaction };
  }

  it("imports a statement, matches one row and never mutates the ledger", async () => {
    const { admin, transaction } = await seedTenantWithDeposit();
    const { importProviderStatement, getStatementImportDetail } = await import(
      "@/lib/actions/provider-statement.actions"
    );

    const result = await importProviderStatement({
      provider: "mtn",
      fileName: "mtn-nov-01.csv",
      csv: CSV,
    });
    expect(result.success).toBe(true);
    const data = result.data as {
      importId: string;
      matchedRows: number;
      unmatchedRows: number;
      financialMutation: boolean;
    };
    expect(data.matchedRows).toBe(1);
    expect(data.unmatchedRows).toBe(2);
    expect(data.financialMutation).toBe(false);

    const unchanged = await prisma.momoTransaction.findUnique({ where: { id: transaction.id } });
    expect(Number(unchanged?.amount)).toBe(250);
    // A human/auto comparison is NOT a provider confirmation.
    expect(unchanged?.verificationStatus).toBe("operator_recorded");
    expect(unchanged?.recordingSource).toBe("manual_operator");

    const detail = await getStatementImportDetail(data.importId);
    expect(detail?.rows).toHaveLength(3);
    const matched = detail?.rows.find((row) => row.status === "matched");
    expect(matched?.matchType).toBe("exact_reference");
    expect(matched?.matchedReference).toBe("MTN-1");
    expect(detail?.totals.matchedIn).toBe(250);

    const audits = await prisma.auditLog.findMany({
      where: { tenantId: admin.tenantId!, action: "provider_statement.imported" },
    });
    expect(audits).toHaveLength(1);
    const details = JSON.parse(String(audits[0].details)) as Record<string, unknown>;
    expect(details.financialMutation).toBe(false);
    expect(details.rowCount).toBe(3);
  });

  it("refuses the same file twice and detects a duplicated line across files", async () => {
    await setAdminSession(await createTestAdmin());
    const { importProviderStatement } = await import("@/lib/actions/provider-statement.actions");

    const first = await importProviderStatement({
      provider: "mtn",
      fileName: "one.csv",
      csv: CSV,
    });
    expect(first.success).toBe(true);

    const sameBytes = await importProviderStatement({
      provider: "mtn",
      fileName: "one-copy.csv",
      csv: CSV,
    });
    expect(sameBytes.success).toBe(false);
    expect(sameBytes.error).toMatch(/already been imported/i);

    // A different file that repeats two of the three lines keeps the evidence and
    // records the repeats as duplicates.
    const overlapping = [HEADER, CSV.split("\n")[1], CSV.split("\n")[2], "MTN-9,2026-11-02 08:00:00,Credit,10.00,0.00,10.00,New"].join("\n");
    const second = await importProviderStatement({
      provider: "mtn",
      fileName: "two.csv",
      csv: overlapping,
    });
    expect(second.success).toBe(true);
    expect((second.data as { duplicateRows: number }).duplicateRows).toBe(2);
  });

  it("keeps imports tenant-scoped", async () => {
    await setAdminSession(await createTestAdmin());
    const { importProviderStatement, getStatementImports } = await import(
      "@/lib/actions/provider-statement.actions"
    );
    await importProviderStatement({ provider: "mtn", fileName: "a.csv", csv: CSV });

    // Switch the acting tenant: a second administrator must see nothing.
    const otherTenant = await createTestTenant();
    const otherAdmin = await createTestAdmin({ tenantId: otherTenant.id });
    expect(otherAdmin.tenantId).toBe(otherTenant.id);
    await setAdminSession(otherAdmin);
    const rows = await getStatementImports();
    expect(rows).toHaveLength(0);
  });

  it("records invalid rows without importing them as valid", async () => {
    await setAdminSession(await createTestAdmin());
    const { importProviderStatement, getStatementImportDetail } = await import(
      "@/lib/actions/provider-statement.actions"
    );
    const csv = [HEADER, "MTN-1,not-a-date,Credit,250.00,1.00,1250.00,Bad"].join("\n");
    const result = await importProviderStatement({
      provider: "mtn",
      fileName: "bad.csv",
      csv,
    });
    expect(result.success).toBe(true);
    const detail = await getStatementImportDetail((result.data as { importId: string }).importId);
    expect(detail?.rows[0].status).toBe("invalid");
    expect(detail?.rows[0].validationError).toMatch(/date/i);
  });

  it("rejects an unsupported provider and an empty file", async () => {
    await setAdminSession(await createTestAdmin());
    const { importProviderStatement } = await import("@/lib/actions/provider-statement.actions");
    expect(
      (await importProviderStatement({ provider: "vodafone", fileName: "x.csv", csv: CSV })).success
    ).toBe(false);
    expect(
      (await importProviderStatement({ provider: "mtn", fileName: "x.csv", csv: "" })).success
    ).toBe(false);
  });
});
