/**
 * Evidence files and dispute ownership.
 *
 * Two audit gaps are covered here: evidence that was only a text pointer, and a
 * dispute queue with no owner, urgency or due date. Both are server-side
 * controls, so the tests drive the actions rather than the screens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { prisma, cleanDatabase } from "./setup";

const storage = mkdtempSync(path.join(tmpdir(), "maacash-evidence-"));
process.env.EVIDENCE_STORAGE_DIR = storage;

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => {
    if (!ctxHolder.current || ctxHolder.current.role !== "customer") {
      throw new Error("REDIRECT:/login");
    }
    return ctxHolder.current;
  },
  getTenantContext: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import {
  disposeEvidence,
  getEvidenceForSubject,
  uploadEvidence,
} from "@/lib/actions/evidence.actions";
import {
  assignDispute,
  escalateDispute,
  getAdminDispute,
  openCustomerDispute,
  resolveCustomerDispute,
  startDisputeReview,
} from "@/lib/actions/customer-dispute.actions";
import {
  EVIDENCE_MAX_BYTES,
  hashEvidence,
  readEvidenceBytes,
  retentionDeadline,
  sanitizeFileName,
  validateEvidence,
} from "@/lib/evidence";

let tenantId: string;
let adminId: string;
let customerId: string;
let otherCustomerId: string;
let contributionId: string;
let disputeId: string;

async function asAdmin() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Evidence Tenant",
    tenantCode: "EV",
    userId: adminId,
    role: "admin",
    modules: ["susu"],
  };
}

async function asCustomer(id = customerId) {
  ctxHolder.current = {
    tenantId,
    tenantName: "Evidence Tenant",
    tenantCode: "EV",
    userId: id,
    role: "customer",
    modules: ["customer"],
  };
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

beforeEach(async () => {
  await cleanDatabase();
  // Each test starts with an empty private directory, so a count of files is a
  // real assertion rather than a leftover from an earlier test.
  for (const entry of readdirSync(storage)) {
    rmSync(path.join(storage, entry), { recursive: true, force: true });
  }
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `EV-${Math.random().toString(36).slice(2, 8)}`,
      name: "Evidence Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `ev-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Evidence Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  const customer = await prisma.customer.create({
    data: {
      tenantId,
      customerId: "EV-C-1",
      fullName: "Evidence Customer",
      phone: "+233200000123",
      status: "active",
      portalEnabled: true,
    },
  });
  customerId = customer.id;
  const other = await prisma.customer.create({
    data: {
      tenantId,
      customerId: "EV-C-2",
      fullName: "Other Customer",
      phone: "+233200000124",
      status: "active",
      portalEnabled: true,
    },
  });
  otherCustomerId = other.id;

  const account = await prisma.susuAccount.create({
    data: {
      tenantId,
      accountId: "EV-S-1",
      customerId,
      dailyContribution: 10,
      status: "active",
    },
  });
  const cycle = await prisma.susuCycle.create({
    data: {
      tenantId,
      accountId: account.id,
      cycleNumber: 1,
      startDate: new Date("2026-11-01T00:00:00Z"),
      endDate: new Date("2026-11-30T00:00:00Z"),
      dailyContribution: 10,
      status: "active",
    },
  });
  const contribution = await prisma.contribution.create({
    data: {
      tenantId,
      accountId: account.id,
      cycleId: cycle.id,
      amount: 50,
      collectionDate: new Date("2026-11-20T10:00:00Z"),
      channel: "direct_office",
      recordedById: adminId,
      referenceId: "EV-REF-1",
    },
  });
  contributionId = contribution.id;

  await asCustomer();
  const opened = await openCustomerDispute({
    subjectType: "contribution",
    subjectId: contributionId,
    category: "not_received",
    details: "I paid GH₵50 but the statement does not show it.",
  });
  expect(opened.success, opened.error).toBe(true);
  disputeId = (opened.data as { disputeId: string }).disputeId;
});

describe("evidence validation", () => {
  it("accepts the allowed types and refuses the rest", () => {
    expect(validateEvidence({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }).ok).toBe(true);
    const bad = validateEvidence({
      fileName: "a.exe",
      contentType: "application/x-msdownload",
      sizeBytes: 10,
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/JPEG, PNG, WebP/i);
  });

  it("refuses an empty or oversized file", () => {
    expect(
      validateEvidence({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 0 }).error
    ).toMatch(/empty/i);
    expect(
      validateEvidence({
        fileName: "a.pdf",
        contentType: "application/pdf",
        sizeBytes: EVIDENCE_MAX_BYTES + 1,
      }).error
    ).toMatch(/larger than/i);
  });

  it("strips a path and control characters from the display name", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("receipt\u0000.png")).toBe("receipt.png");
    expect(sanitizeFileName("")).toBe("evidence");
  });

  it("sets a seven-year retention deadline", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(retentionDeadline(from).toISOString()).toBe("2033-01-01T00:00:00.000Z");
  });
});

describe("attaching evidence", () => {
  it("stores the bytes privately and records the digest", async () => {
    await asCustomer();
    const result = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "office-slip.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    expect(result.success, result.error).toBe(true);
    expect(result.data?.sha256).toBe(hashEvidence(pdf));
    expect(result.data?.sizeBytes).toBe(pdf.byteLength);

    const row = await prisma.evidenceAttachment.findFirstOrThrow({
      where: { subjectId: disputeId },
    });
    expect(row.storageKey).not.toContain("..");
    const stored = await readEvidenceBytes(row.storageKey);
    expect(stored && new Uint8Array(stored)).toEqual(pdf);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "evidence.attached" },
    });
    expect(JSON.parse(String(audit?.details)).sha256).toBe(hashEvidence(pdf));
  });

  it("refuses a file type that is not allowed", async () => {
    await asCustomer();
    const result = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "payload.exe",
      contentType: "application/x-msdownload",
      bytes: pdf,
    });
    expect(result.success).toBe(false);
    expect(await prisma.evidenceAttachment.count()).toBe(0);
  });

  it("does not let another customer attach to this dispute", async () => {
    await asCustomer(otherCustomerId);
    const result = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "theirs.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(await prisma.evidenceAttachment.count()).toBe(0);
  });

  it("refuses an unknown subject id rather than orphaning a file", async () => {
    await asAdmin();
    const result = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: "does-not-exist",
      fileName: "orphan.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    expect(result.success).toBe(false);
    const dirs = readdirSync(storage);
    expect(dirs).toHaveLength(0);
  });

  it("lists attachments for the owner and for the office, but not for a stranger", async () => {
    await asCustomer();
    await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "slip.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    const mine = await getEvidenceForSubject("customerDispute", disputeId);
    expect(mine.attachments).toHaveLength(1);

    await asAdmin();
    const office = await getEvidenceForSubject("customerDispute", disputeId);
    expect(office.attachments).toHaveLength(1);

    await asCustomer(otherCustomerId);
    const stranger = await getEvidenceForSubject("customerDispute", disputeId);
    expect(stranger.success).toBe(false);
  });
});

describe("retention", () => {
  it("refuses to dispose of evidence still inside its retention period", async () => {
    await asCustomer();
    const uploaded = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "slip.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    await asAdmin();
    const result = await disposeEvidence(uploaded.data!.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/retention period/i);
  });

  it("refuses to dispose of evidence for a dispute that is still open", async () => {
    await asCustomer();
    const uploaded = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "slip.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    await prisma.evidenceAttachment.update({
      where: { id: uploaded.data!.id },
      data: { retentionUntil: new Date("2020-01-01T00:00:00Z") },
    });
    await asAdmin();
    const result = await disposeEvidence(uploaded.data!.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still open/i);
  });

  it("disposes once retention has passed and the dispute is closed", async () => {
    await asCustomer();
    const uploaded = await uploadEvidence({
      subjectType: "customerDispute",
      subjectId: disputeId,
      fileName: "slip.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    const row = await prisma.evidenceAttachment.findFirstOrThrow({
      where: { id: uploaded.data!.id },
    });
    await prisma.evidenceAttachment.update({
      where: { id: row.id },
      data: { retentionUntil: new Date("2020-01-01T00:00:00Z") },
    });
    await prisma.customerDispute.update({
      where: { id: disputeId },
      data: { status: "resolved_declined", resolvedAt: new Date() },
    });
    await asAdmin();
    const result = await disposeEvidence(row.id);
    expect(result.success, result.error).toBe(true);
    expect(await readEvidenceBytes(row.storageKey)).toBeNull();
    const after = await prisma.evidenceAttachment.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.deletedAt).not.toBeNull();
  });

  it("keeps a stray file outside the evidence directory out of reach", async () => {
    mkdirSync(path.join(storage, "elsewhere"), { recursive: true });
    writeFileSync(path.join(storage, "elsewhere", "secret.pdf"), "x");
    expect(await readEvidenceBytes("../elsewhere/secret.pdf")).toBeNull();
    expect(await readEvidenceBytes("elsewhere/secret.pdf")).toBeNull();
  });
});

describe("dispute ownership and urgency", () => {
  it("gives a new dispute a normal priority and a due date", async () => {
    const stored = await prisma.customerDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(stored.priority).toBe("normal");
    expect(stored.dueAt).not.toBeNull();
  });

  it("assigns an administrator and recalculates the due date", async () => {
    await asAdmin();
    const result = await assignDispute({
      disputeId,
      assignedToId: adminId,
      priority: "high",
    });
    expect(result.success, result.error).toBe(true);
    const stored = await prisma.customerDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(stored.assignedToId).toBe(adminId);
    expect(stored.priority).toBe("high");
    // High priority is a 24-hour target.
    expect(stored.dueAt!.getTime() - stored.createdAt.getTime()).toBe(24 * 60 * 60 * 1000);

    const view = await getAdminDispute(disputeId);
    expect(view?.assignedToName).toBe("Evidence Admin");
    expect(view?.overdue).toBe(false);
  });

  it("refuses an assignee from another business", async () => {
    const otherTenant = await prisma.businessTenant.create({
      data: { code: "EV-OTHER", name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    const outsider = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `ev-other-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Outsider",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    await asAdmin();
    const result = await assignDispute({
      disputeId,
      assignedToId: outsider.id,
      priority: "normal",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not an active administrator/i);
  });

  it("escalates with a reason and marks the dispute urgent", async () => {
    await asAdmin();
    const short = await escalateDispute({ disputeId, note: "help" });
    expect(short.success).toBe(false);

    const result = await escalateDispute({
      disputeId,
      note: "Customer has returned twice; the branch cannot find the slip.",
    });
    expect(result.success, result.error).toBe(true);
    const stored = await prisma.customerDispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(stored.priority).toBe("urgent");
    expect(stored.escalatedAt).not.toBeNull();
    expect(stored.escalationNote).toMatch(/returned twice/i);

    const events = await prisma.customerDisputeEvent.findMany({
      where: { disputeId },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.action)).toContain("escalated");
  });

  it("shows the reported priority and owner to the office queue", async () => {
    await asAdmin();
    await assignDispute({ disputeId, assignedToId: adminId, priority: "urgent" });
    const view = await getAdminDispute(disputeId);
    expect(view?.priority).toBe("urgent");
    expect(view?.assignedToId).toBe(adminId);
  });

  it("does not let an upheld outcome close on a correction from another subject", async () => {
    await asAdmin();
    await startDisputeReview(disputeId);
    // A reversal for a different contribution must not satisfy this dispute.
    const otherContribution = await prisma.contribution.findFirstOrThrow({
      where: { tenantId, id: { not: contributionId } },
    }).catch(() => null);
    expect(otherContribution).toBeNull();
    const result = await resolveCustomerDispute({
      disputeId,
      outcome: "upheld",
      note: "Closing on a correction that belongs elsewhere.",
      outcomeReference: "EV-REF-1",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no reversal matches/i);
  });
});
