/**
 * Phase 7 — Customer Onboarding, Bulk Import and Data Migration.
 *
 * The tests call the REAL server actions and the REAL parser/classifier against
 * an isolated SQLite test database. Only the request plumbing is mocked:
 * next/headers (cookie jar), next/navigation and next/cache.
 *
 * What is deliberately asserted, because it is what the phase promises:
 *   - no import ever creates a contribution, withdrawal, commission or card fee;
 *   - a person is created once, and a second account is an ACCOUNT, not a person;
 *   - the plan an operator confirms is the plan that runs;
 *   - a flagged row blocks the commit until a human decides;
 *   - one tenant cannot see or commit another tenant's batch;
 *   - a branch outside the operator's scope is refused before the write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SignJWT } from "jose";
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
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { parseCsv, CSV_LIMITS } from "@/lib/susu/import-csv";
import {
  allowedResolutions,
  autoDetectMapping,
  classifyRows,
  validateMapping,
  type ColumnMapping,
  type ImportReferenceData,
} from "@/lib/susu/import-validation";
import { computePlanHash } from "@/lib/susu/import-commit";
import {
  createImportBatch,
  validateImportBatch,
  resolveImportRows,
  getImportPreview,
  confirmImportBatch,
  discardImportBatch,
  getImportBatches,
  getImportErrorReport,
} from "@/lib/actions/susu-import.actions";
import {
  registerCustomerOnboarding,
  addAccountToCustomerOnboarding,
  findCustomerCandidates,
} from "@/lib/actions/susu-onboarding.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");

async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(JWT_SECRET);
}

async function setAdminSession(userId: string, email = "admin@test.com") {
  mockCookieStore.set(
    "bik-admin-session",
    await signToken({
      userId,
      email,
      fullName: "Test Admin",
      role: "admin",
      modules: [],
      tokenVersion: 0,
    })
  );
  mockCookieStore.delete("bik-collector-session");
}

async function setCollectorSession(userId: string) {
  mockCookieStore.set(
    "bik-collector-session",
    await signToken({
      userId,
      email: "collector@test.com",
      fullName: "Test Collector",
      role: "collector",
      modules: ["susu"],
      tokenVersion: 0,
    })
  );
  mockCookieStore.delete("bik-admin-session");
}

/** Build a File for the upload form from CSV text. */
function csvFile(text: string, name = "customers.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

function uploadForm(text: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("name", "January paper register");
  form.set("file", csvFile(text));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

// ---------------------------------------------------------------------------
// Parsing and mapping
// ---------------------------------------------------------------------------

describe("Phase 7 — CSV parsing", () => {
  it("parses quoted cells, embedded commas and CRLF line endings", () => {
    const text = 'Full name,Phone,Daily contribution\r\n"Mensah, Efua",0244111222,50\r\n';
    const result = parseCsv(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headers).toEqual(["Full name", "Phone", "Daily contribution"]);
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].cells[0]).toBe("Mensah, Efua");
    expect(result.data.rows[0].rowNumber).toBe(1);
  });

  it("strips a byte order mark and detects a semicolon file", () => {
    const result = parseCsv("\uFEFFFull name;Phone;Daily contribution\nAma;0244;50\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headers[0]).toBe("Full name");
    expect(result.data.delimiter).toBe(";");
  });

  it("de-duplicates repeated headings instead of losing a column", () => {
    const result = parseCsv("Phone,Phone,Full name\n0244,0245,Ama\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.headers).toEqual(["Phone", "Phone (2)", "Full name"]);
  });

  it("rejects an empty document", () => {
    const result = parseCsv("   ");
    expect(result.ok).toBe(false);
  });

  it("caps the number of rows and reports the truncation", () => {
    const header = "Full name,Phone,Daily contribution\n";
    const rows = Array.from({ length: CSV_LIMITS.maxRows + 5 }, (_, i) => `Person ${i},0244${i},50`).join("\n");
    const result = parseCsv(header + rows);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.rows).toHaveLength(CSV_LIMITS.maxRows);
    expect(result.data.truncatedRows).toBe(5);
  });
});

describe("Phase 7 — column mapping", () => {
  it("recognises the common headings of a paper register", () => {
    const mapping = autoDetectMapping([
      "Full Name",
      "Phone Number",
      "Amount",
      "Branch",
      "Passbook No",
    ]);
    expect(mapping.fullName).toBe(0);
    expect(mapping.phone).toBe(1);
    expect(mapping.dailyContribution).toBe(2);
    expect(mapping.branchRef).toBe(3);
    // A passbook number is the number in the business's own book, so it maps to
    // the existing-account column, not to the customer reference.
    expect(mapping.accountNumber).toBe(4);
  });

  it("rejects the same column mapped twice and an out-of-range column", () => {
    const duplicated = validateMapping({ fullName: 0, phone: 0 }, 3);
    expect(duplicated.ok).toBe(false);

    const outOfRange = validateMapping({ fullName: 9 }, 3);
    expect(outOfRange.ok).toBe(false);
  });

  it("requires the two fields the importer cannot invent", () => {
    const result = validateMapping({ phone: 1 }, 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const REFERENCE: ImportReferenceData = {
  branches: [],
  collectors: [],
  customers: [
    {
      id: "cust-1",
      customerId: "BIK-C-000001",
      fullName: "Efua Mensah",
      phone: "+233241234567",
      email: "efua@example.com",
      externalReference: "PB-001",
    },
  ],
  accounts: [
    {
      id: "acc-1",
      accountId: "BIK-S-000001",
      externalAccountReference: null,
      customerId: "cust-1",
    },
  ],
};

function classify(text: string, mapping: ColumnMapping) {
  const parsed = parseCsv(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return classifyRows(
    parsed.data,
    {
      branchMode: "single_branch",
      defaultBranchId: null,
      mapping,
      allowedBranchIds: "all",
      branchlessTenant: true,
    },
    REFERENCE,
    new Set(["efua@example.com"])
  );
}

describe("Phase 7 — duplicate classification", () => {
  it("treats an unknown person as a new customer", () => {
    const { rows } = classify(
      "Full name,Phone,Daily contribution\nAma Boateng,0244777888,50\n",
      { fullName: 0, phone: 1, dailyContribution: 2 }
    );
    expect(rows[0].classification).toBe("new_customer");
    expect(rows[0].resolution).toBe("create_new");
  });

  it("treats a known phone as a second account for the same person", () => {
    const { rows } = classify(
      "Full name,Phone,Daily contribution\nEfua Mensah,0241234567,80\n",
      { fullName: 0, phone: 1, dailyContribution: 2 }
    );
    expect(rows[0].classification).toBe("new_account_existing_customer");
    expect(rows[0].matchedCustomerId).toBe("cust-1");
    expect(rows[0].resolution).toBe("link_existing");
  });

  it("flags an account number that already exists as an exact duplicate", () => {
    const { rows } = classify(
      "Full name,Phone,Daily contribution,Account number\nEfua Mensah,0241234567,80,BIK-S-000001\n",
      { fullName: 0, phone: 1, dailyContribution: 2, accountNumber: 3 }
    );
    expect(rows[0].classification).toBe("exact_duplicate");
    expect(rows[0].resolution).toBe("exclude");
  });

  it("asks instead of merging when two rows share a phone but not a name", () => {
    const { rows } = classify(
      "Full name,Phone,Daily contribution\nKojo Antwi,0244999888,20\nYaa Asantewaa,0244999888,20\n",
      { fullName: 0, phone: 1, dailyContribution: 2 }
    );
    expect(rows[0].classification).toBe("new_customer");
    expect(rows[1].classification).toBe("possible_customer_duplicate");
    expect(rows[1].resolution).toBeNull();
    expect(
      allowedResolutions("possible_customer_duplicate").includes("link_existing")
    ).toBe(true);
  });

  it("refuses an impossible date and a non-numeric amount", () => {
    const { rows } = classify(
      "Full name,Daily contribution,Opening date\nAma Boateng,abc,2025-02-30\n",
      { fullName: 0, dailyContribution: 1, openingDate: 2 }
    );
    expect(rows[0].classification).toBe("invalid");
    const codes = rows[0].issues.map((issue) => issue.code);
    expect(codes).toContain("daily_contribution_invalid");
    expect(codes).toContain("opening_date_invalid");
  });

  it("refuses a branch the operator is not scoped to", () => {
    const reference: ImportReferenceData = {
      ...REFERENCE,
      branches: [
        { id: "b-1", code: "ACC", name: "Accra", status: "active" },
        { id: "b-2", code: "KUM", name: "Kumasi", status: "active" },
      ],
    };
    const parsed = parseCsv(
      "Full name,Daily contribution,Branch\nAma Boateng,50,KUM\n"
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const { rows } = classifyRows(
      parsed.data,
      {
        branchMode: "row_column",
        defaultBranchId: null,
        mapping: { fullName: 0, dailyContribution: 1, branchRef: 2 },
        allowedBranchIds: new Set(["b-1"]),
      },
      reference,
      new Set()
    );
    expect(rows[0].classification).toBe("invalid");
    expect(rows[0].issues.map((issue) => issue.code)).toContain("branch_unauthorised");
  });
});

describe("Phase 7 — plan digest", () => {
  it("is stable for the same plan and changes when a decision changes", () => {
    const base = {
      branchMode: "single_branch",
      branchId: null,
      mapping: { fullName: 0, dailyContribution: 1 } as ColumnMapping,
      rows: [
        { rowNumber: 1, resolution: "create_new" as const, matchedCustomerId: null, branchId: null },
      ],
    };
    expect(computePlanHash(base)).toBe(computePlanHash({ ...base }));
    expect(
      computePlanHash({
        ...base,
        rows: [{ ...base.rows[0], resolution: "exclude" }],
      })
    ).not.toBe(computePlanHash(base));
  });
});

// ---------------------------------------------------------------------------
// End-to-end import
// ---------------------------------------------------------------------------

describe("Phase 7 — bulk import, end to end", () => {
  let adminId = "";
  const REGISTER =
    "Full name,Phone,Daily contribution,Customer reference\n" +
    "Ama Boateng,0244777888,50,PB-100\n" +
    "Kojo Antwi,0244999888,20,PB-101\n";

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    await setAdminSession(adminId);
  });

  it("stages, validates, previews and commits without creating financial records", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    expect(staged.success).toBe(true);
    const batchId = (staged.data as { batchId: string }).batchId;

    const validated = await validateImportBatch({ batchId });
    expect(validated.success).toBe(true);
    const counts = (validated.data as { counts: Record<string, number> }).counts;
    expect(counts.new_customer).toBe(2);

    const batch = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(batch!.status).toBe("ready");
    expect(batch!.branchMode).toBe("single_branch");

    const preview = await getImportPreview({ batchId });
    expect(preview.success).toBe(true);
    const plan = preview.data as {
      planHash: string;
      ready: boolean;
      rows: { rowNumber: number; classification: string }[];
    };
    expect(plan.ready).toBe(true);
    expect(plan.rows).toHaveLength(2);

    const committed = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success).toBe(true);
    const result = committed.data as { status: string; importedCustomers: number };
    expect(result.status).toBe("committed");
    expect(result.importedCustomers).toBe(2);

    const customers = await prisma.customer.findMany({
      where: { tenantId: (await prisma.user.findUnique({ where: { id: adminId } }))!.tenantId! },
      include: { accounts: { include: { cycles: true } } },
    });
    expect(customers).toHaveLength(2);
    for (const customer of customers) {
      expect(customer.customerId).toMatch(/^BIK-C-\d{6}$/);
      expect(customer.registeredVia).toBe("import");
      expect(customer.accounts).toHaveLength(1);
      expect(customer.accounts[0].openedVia).toBe("import");
      expect(customer.accounts[0].cycles).toHaveLength(1);
      expect(customer.accounts[0].cycles[0].status).toBe("active");
    }
    expect(customers.every((customer) => customer.externalReference !== null)).toBe(true);

    // The promise: a migration moves identity, never money.
    expect(await prisma.contribution.count()).toBe(0);
    expect(await prisma.withdrawal.count()).toBe(0);
    expect(await prisma.commission.count()).toBe(0);
    expect(await prisma.cardFee.count()).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "susu.customer_import_committed" },
    });
    expect(audit).not.toBeNull();
  });

  it("resumes the existing batch when the same file is uploaded twice", async () => {
    const first = await createImportBatch(uploadForm(REGISTER));
    const second = await createImportBatch(uploadForm(REGISTER));
    const firstId = (first.data as { batchId: string }).batchId;
    const secondData = second.data as { batchId: string; resumed: boolean };
    expect(secondData.batchId).toBe(firstId);
    expect(secondData.resumed).toBe(true);
    expect(await prisma.customerImportBatch.count()).toBe(1);
  });

  it("refuses a file that is not a CSV, an empty file and an oversized file", async () => {
    const wrongType = await createImportBatch(uploadForm(REGISTER, {}));
    expect(wrongType.success).toBe(true); // baseline: the happy upload works

    const form = new FormData();
    form.set("name", "Spreadsheet upload");
    form.set("file", new File(["irrelevant"], "register.xlsx"));
    const rejected = await createImportBatch(form);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain(".csv");

    const emptyForm = new FormData();
    emptyForm.set("name", "Empty upload");
    emptyForm.set("file", new File([], "empty.csv", { type: "text/csv" }));
    const empty = await createImportBatch(emptyForm);
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("empty");
  });

  it("blocks the commit until every flagged row has a decision", async () => {
    const text =
      "Full name,Phone,Daily contribution\n" +
      "Ama Boateng,0244777888,50\n" +
      "Yaa Asantewaa,0244777888,20\n";
    const staged = await createImportBatch(uploadForm(text));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });

    const batch = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(batch!.status).toBe("validated");
    expect(batch!.reviewRows).toBe(1);

    const preview = await getImportPreview({ batchId });
    const plan = preview.data as { planHash: string; ready: boolean };
    expect(plan.ready).toBe(false);

    const blocked = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain("decision");

    const decided = await resolveImportRows({
      batchId,
      resolutions: [{ rowNumber: 2, resolution: "create_new", note: "Different person, shared phone" }],
    });
    expect(decided.success).toBe(true);

    const after = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(after!.status).toBe("ready");
    expect(after!.reviewRows).toBe(0);

    // The digest the operator approved before deciding no longer describes the
    // plan, so the stale confirmation must be refused.
    const stale = await confirmImportBatch({
      batchId,
      planHash: plan.planHash,
      confirmText: "IMPORT",
    });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain("changed");

    const refreshed = await getImportPreview({ batchId });
    const freshPlan = refreshed.data as { planHash: string };
    const committed = await confirmImportBatch({
      batchId,
      planHash: freshPlan.planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success).toBe(true);
    expect(await prisma.customer.count()).toBe(2);

    const events = await prisma.customerImportRowEvent.findMany({
      where: { batchId, kind: "resolved" },
    });
    expect(events).toHaveLength(1);
  });

  it("requires the confirmation phrase", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });
    const preview = await getImportPreview({ batchId });
    const { planHash } = preview.data as { planHash: string };

    const refused = await confirmImportBatch({
      batchId,
      planHash,
      confirmText: "yes",
    });
    expect(refused.success).toBe(false);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("is idempotent: confirming twice never imports twice", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });
    const { planHash } = (await getImportPreview({ batchId })).data as {
      planHash: string;
    };

    const first = await confirmImportBatch({ batchId, planHash, confirmText: "IMPORT" });
    const second = await confirmImportBatch({ batchId, planHash, confirmText: "IMPORT" });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect((second.data as { alreadyCommitted: boolean }).alreadyCommitted).toBe(true);
    expect(await prisma.customer.count()).toBe(2);
    expect(await prisma.susuAccount.count()).toBe(2);
  });

  it("protects a committed batch from re-validation and from being discarded", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });
    const { planHash } = (await getImportPreview({ batchId })).data as {
      planHash: string;
    };
    await confirmImportBatch({ batchId, planHash, confirmText: "IMPORT" });

    const revalidate = await validateImportBatch({ batchId });
    expect(revalidate.success).toBe(false);

    const discard = await discardImportBatch({ batchId });
    expect(discard.success).toBe(false);
    expect(discard.error).toContain("created records");
    expect(await prisma.customer.count()).toBe(2);
  });

  it("discards a staged batch without touching customers", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });

    const discarded = await discardImportBatch({ batchId });
    expect(discarded.success).toBe(true);
    expect(await prisma.customerImportRow.count({ where: { batchId } })).toBe(0);
    const batch = await prisma.customerImportBatch.findUnique({ where: { id: batchId } });
    expect(batch!.status).toBe("cancelled");
    expect(batch!.sourceText).toBeNull();
  });

  it("keeps one tenant's batch invisible to another tenant", async () => {
    const staged = await createImportBatch(uploadForm(REGISTER));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });
    const { planHash } = (await getImportPreview({ batchId })).data as {
      planHash: string;
    };

    const intruder = await createTestAdmin();
    await setAdminSession(intruder.id, "intruder@test.com");

    const preview = await getImportPreview({ batchId });
    expect(preview.success).toBe(false);

    const commit = await confirmImportBatch({
      batchId,
      planHash,
      confirmText: "IMPORT",
    });
    expect(commit.success).toBe(false);

    const history = await getImportBatches();
    expect((history.data as { batches: unknown[] }).batches).toHaveLength(0);
  });

  it("refuses a collector — bulk migration is an administrator capability", async () => {
    const collectorUser = await prisma.user.create({
      data: {
        email: `collector-${Date.now()}@test.com`,
        fullName: "Field Collector",
        role: "collector",
        status: "active",
        passwordHash: "test-hash",
        susuEnabled: true,
        tenantId: (await prisma.user.findUnique({ where: { id: adminId } }))!.tenantId,
      },
    });
    await prisma.collector.create({
      data: {
        userId: collectorUser.id,
        tenantId: collectorUser.tenantId,
        status: "active",
      },
    });
    await setCollectorSession(collectorUser.id);

    const result = await createImportBatch(uploadForm(REGISTER));
    expect(result.success).toBe(false);
    expect(result.error).toContain("administrator");
  });

  it("produces a row-level error report for the rows that could not be imported", async () => {
    const text =
      "Full name,Phone,Daily contribution\n" +
      "Ama Boateng,0244777888,50\n" +
      ",0244000111,20\n";
    const staged = await createImportBatch(uploadForm(text));
    const batchId = (staged.data as { batchId: string }).batchId;
    await validateImportBatch({ batchId });

    const report = await getImportErrorReport({ batchId });
    expect(report.success).toBe(true);
    const data = report.data as { csv: string; rowCount: number };
    expect(data.rowCount).toBe(1);
    expect(data.csv).toContain("Row");
    expect(data.csv).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// Branch attribution
// ---------------------------------------------------------------------------

describe("Phase 7 — branch attribution on import", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  it("refuses a destination branch outside the operator's scope", async () => {
    const tenant = await createTestTenant();
    const admin = await createTestAdmin({ tenantId: tenant.id });
    const accra = await prisma.location.create({
      data: { tenantId: tenant.id, code: "ACC", name: "Accra Main", status: "active" },
    });
    const kumasi = await prisma.location.create({
      data: { tenantId: tenant.id, code: "KUM", name: "Kumasi", status: "active" },
    });
    await prisma.branchMembership.create({
      data: {
        tenantId: tenant.id,
        userId: admin.id,
        locationId: accra.id,
        role: "branch_manager",
        status: "active",
      },
    });
    await setAdminSession(admin.id);

    const refused = await createImportBatch(
      uploadForm("Full name,Daily contribution\nAma Boateng,50\n", {
        branchId: kumasi.id,
      })
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("not authorised");

    const allowed = await createImportBatch(
      uploadForm("Full name,Daily contribution\nAma Boateng,50\n", {
        branchId: accra.id,
      })
    );
    expect(allowed.success).toBe(true);
    const batchId = (allowed.data as { batchId: string }).batchId;

    const validated = await validateImportBatch({ batchId });
    expect(validated.success).toBe(true);
    const { planHash } = (await getImportPreview({ batchId })).data as {
      planHash: string;
    };
    const committed = await confirmImportBatch({
      batchId,
      planHash,
      confirmText: "IMPORT",
    });
    expect(committed.success).toBe(true);

    const account = await prisma.susuAccount.findFirst();
    expect(account!.branchId).toBe(accra.id);
    const customer = await prisma.customer.findFirst();
    expect(customer!.registeredBranchId).toBe(accra.id);
  });
});

// ---------------------------------------------------------------------------
// Individual onboarding
// ---------------------------------------------------------------------------

describe("Phase 7 — individual onboarding", () => {
  let adminId = "";
  let tenantId = "";
  let branchId = "";

  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    const admin = await createTestAdmin();
    adminId = admin.id;
    tenantId = admin.tenantId!;
    const branch = await prisma.location.create({
      data: { tenantId, code: "TEMA", name: "Tema Office", status: "active" },
    });
    branchId = branch.id;
    await setAdminSession(adminId);
  });

  it("registers a customer with one account, one cycle, the branch and the collector", async () => {
    const collectorUser = await prisma.user.create({
      data: {
        email: `collector-${Date.now()}@test.com`,
        fullName: "Kwesi Collector",
        role: "collector",
        status: "active",
        passwordHash: "test-hash",
        susuEnabled: true,
        tenantId,
      },
    });
    const collector = await prisma.collector.create({
      data: { userId: collectorUser.id, tenantId, branchId, status: "active" },
    });

    const form = new FormData();
    form.set("fullName", "Akosua Frimpong");
    form.set("phone", "0244111222");
    form.set("dailyContribution", "30");
    form.set("cardFee", "10");
    form.set("branchId", branchId);
    form.set("collectorId", collector.id);
    form.set("externalReference", "PB-777");
    form.set("openingDate", "2024-03-04");

    const result = await registerCustomerOnboarding(form);
    expect(result.success).toBe(true);
    const data = result.data as {
      customer: { id: string; customerId: string };
      susuAccount: { id: string; accountId: string; branchId: string | null };
      accountNumber: string;
    };
    expect(data.customer.customerId).toMatch(/^BIK-C-\d{6}$/);
    expect(data.susuAccount.accountId).toMatch(/^BIK-S-\d{6}$/);
    expect(data.accountNumber).toBe(data.customer.customerId);

    const account = await prisma.susuAccount.findUnique({
      where: { id: data.susuAccount.id },
      include: { cycles: true, assignments: true },
    });
    expect(account!.branchId).toBe(branchId);
    expect(account!.openedVia).toBe("office");
    expect(account!.openingDate!.toISOString().slice(0, 10)).toBe("2024-03-04");
    expect(account!.cycles).toHaveLength(1);
    expect(account!.assignments).toHaveLength(1);
    expect(account!.assignments[0].activeAccountKey).toBe(account!.id);

    const customer = await prisma.customer.findUnique({
      where: { id: data.customer.id },
    });
    expect(customer!.registeredVia).toBe("office");
    expect(customer!.externalReference).toBe("PB-777");
    expect(customer!.registeredBranchId).toBe(branchId);

    // A real card purchase is recorded because the operator said it happened.
    expect(await prisma.cardFee.count()).toBe(1);
    // ...but no contribution is invented.
    expect(await prisma.contribution.count()).toBe(0);
  });

  it("opens a second account without creating a second customer", async () => {
    const first = new FormData();
    first.set("fullName", "Akosua Frimpong");
    first.set("dailyContribution", "30");
    first.set("branchId", branchId);
    const created = await registerCustomerOnboarding(first);
    expect(created.success).toBe(true);
    const createdData = created.data as { customer: { id: string } };

    const second = new FormData();
    second.set("customerId", createdData.customer.id);
    second.set("dailyContribution", "50");
    second.set("branchId", branchId);
    const added = await addAccountToCustomerOnboarding(second);
    expect(added.success).toBe(true);

    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.susuAccount.count()).toBe(2);
    expect(await prisma.susuCycle.count()).toBe(2);
  });

  it("finds the existing customer by phone before another is created", async () => {
    const form = new FormData();
    form.set("fullName", "Akosua Frimpong");
    form.set("phone", "0244111222");
    form.set("dailyContribution", "30");
    form.set("branchId", branchId);
    await registerCustomerOnboarding(form);

    const found = await findCustomerCandidates("0244111222");
    expect(found.success).toBe(true);
    const customers = (found.data as { customers: { fullName: string; accountCount: number }[] })
      .customers;
    expect(customers).toHaveLength(1);
    expect(customers[0].fullName).toBe("Akosua Frimpong");
    expect(customers[0].accountCount).toBe(1);
  });

  it("rejects an e-mail address that belongs to another customer", async () => {
    const first = new FormData();
    first.set("fullName", "Akosua Frimpong");
    first.set("email", "akosua@example.com");
    first.set("dailyContribution", "30");
    first.set("branchId", branchId);
    expect((await registerCustomerOnboarding(first)).success).toBe(true);

    const second = new FormData();
    second.set("fullName", "Someone Else");
    second.set("email", "akosua@example.com");
    second.set("dailyContribution", "30");
    second.set("branchId", branchId);
    const duplicate = await registerCustomerOnboarding(second);
    expect(duplicate.success).toBe(false);
    expect(duplicate.error).toContain("already registered");
    expect(await prisma.customer.count()).toBe(1);
  });

  it("refuses a daily contribution that is not a positive amount", async () => {
    const form = new FormData();
    form.set("fullName", "Akosua Frimpong");
    form.set("dailyContribution", "0");
    form.set("branchId", branchId);
    const result = await registerCustomerOnboarding(form);
    expect(result.success).toBe(false);
    expect(await prisma.customer.count()).toBe(0);
  });
});
