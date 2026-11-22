/**
 * Closed-loop evidence provenance.
 *
 * The point of these tests is the claim a business owner is allowed to make. A record
 * that was typed by an employee, captured on a device, attached to a photo and matched
 * to an imported statement is well evidenced — and still not provider-confirmed, because
 * nothing in this build has an authenticated link to a network. These tests fail if any
 * of that ever quietly changes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import {
  PROVENANCE_EXPLANATIONS,
  PROVENANCE_LABELS,
  PROVENANCE_LEVELS,
  deriveProvenance,
  orderProvenanceTimeline,
  type ProvenanceFacts,
} from "@/lib/evidence-provenance";

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
  requireTenantContext: async () => ctxHolder.current,
  requireTenantAdmin: async () => ctxHolder.current,
}));

import { getTransactionProvenance } from "@/lib/actions/evidence-provenance.actions";

const base: ProvenanceFacts = {
  recorded: true,
  deviceCaptured: false,
  evidenceCount: 0,
  statementMatched: false,
  providerRecordConfirmed: false,
  corrected: false,
  openInvestigation: false,
};

describe("deriveProvenance", () => {
  it("calls an unrecorded subject unrecorded", () => {
    const result = deriveProvenance({ ...base, recorded: false });
    expect(result.level).toBeNull();
    expect(result.providerConfirmed).toBe(false);
    expect(result.labels).toHaveLength(0);
  });

  it("starts every recorded transaction at the declared level", () => {
    const result = deriveProvenance(base);
    expect(result.level).toBe("agent_declared");
    expect(result.labels).toEqual(["agent_declared"]);
    expect(result.providerConfirmed).toBe(false);
  });

  it("adds each fact in order and stops at the strongest", () => {
    const result = deriveProvenance({
      ...base,
      deviceCaptured: true,
      evidenceCount: 2,
      statementMatched: true,
    });
    expect(result.labels).toEqual([
      "agent_declared",
      "device_captured",
      "evidence_attached",
      "statement_matched",
    ]);
    expect(result.level).toBe("statement_matched");
    expect(result.providerConfirmed).toBe(false);
  });

  it("only reaches provider confirmation from a provider record", () => {
    expect(deriveProvenance({ ...base, providerRecordConfirmed: true }).level).toBe(
      "provider_confirmed"
    );
    // A statement match, three pieces of evidence and a device capture still cannot.
    const strong = deriveProvenance({
      ...base,
      deviceCaptured: true,
      evidenceCount: 3,
      statementMatched: true,
    });
    expect(strong.level).not.toBe("provider_confirmed");
  });

  it("always says an imported match is not a live confirmation", () => {
    const result = deriveProvenance({ ...base, statementMatched: true });
    const text = result.notes.join(" ");
    expect(text).toMatch(/imported file is evidence the business kept/i);
    expect(text).toMatch(/no network integration confirmed this transaction/i);
  });

  it("explains a correction and an open investigation in plain language", () => {
    const result = deriveProvenance({ ...base, corrected: true, openInvestigation: true });
    expect(result.notes.join(" ")).toMatch(/corrected or reversed/i);
    expect(result.notes.join(" ")).toMatch(/nothing about it is settled yet/i);
  });

  it("suggests the next strengthening step, and none once confirmed", () => {
    expect(deriveProvenance(base).nextStep).toMatch(/import the provider statement/i);
    expect(deriveProvenance({ ...base, statementMatched: true }).nextStep).toMatch(
      /attach the counter evidence/i
    );
    expect(
      deriveProvenance({ ...base, statementMatched: true, evidenceCount: 1 }).nextStep
    ).toBeNull();
    expect(deriveProvenance({ ...base, providerRecordConfirmed: true }).nextStep).toBeNull();
  });

  it("labels every level without ever saying a network confirmed it", () => {
    for (const level of PROVENANCE_LEVELS) {
      expect(PROVENANCE_LABELS[level].length).toBeGreaterThan(3);
      expect(PROVENANCE_EXPLANATIONS[level].length).toBeGreaterThan(30);
    }
    expect(PROVENANCE_LABELS.agent_declared).toMatch(/declared by an employee/i);
    expect(PROVENANCE_LABELS.statement_matched).toMatch(/imported provider statement/i);
  });

  it("orders a timeline chronologically and keeps undated events last", () => {
    const ordered = orderProvenanceTimeline([
      { at: null, actor: null, label: "open exception", detail: null, providerConfirmed: false },
      {
        at: "2026-12-03T10:00:00.000Z",
        actor: "u1",
        label: "matched",
        detail: null,
        providerConfirmed: false,
      },
      {
        at: "2026-12-01T09:00:00.000Z",
        actor: "u1",
        label: "recorded",
        detail: null,
        providerConfirmed: false,
      },
    ]);
    expect(ordered.map((row) => row.label)).toEqual(["recorded", "matched", "open exception"]);
  });
});

describe("getTransactionProvenance", () => {
  let tenantId: string;
  let adminId: string;
  let locationId: string;
  let transactionId: string;

  beforeEach(async () => {
    await cleanDatabase();
    const tenant = await prisma.businessTenant.create({
      data: {
        code: `PV-${Math.random().toString(36).slice(2, 8)}`,
        name: "Provenance Tenant",
        status: "ACTIVE",
      },
    });
    tenantId = tenant.id;

    const admin = await prisma.user.create({
      data: {
        tenantId,
        email: `pv-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Provenance Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    adminId = admin.id;

    const location = await prisma.location.create({
      data: { tenantId, name: "Main Counter", code: `P${Date.now() % 100000}` },
    });
    locationId = location.id;

    const transaction = await prisma.momoTransaction.create({
      data: {
        tenantId,
        locationId,
        workerId: adminId,
        type: "cash_out",
        network: "mtn",
        direction: "outflow",
        amount: 250,
        businessDate: new Date("2026-12-01T00:00:00.000Z"),
        occurredAt: new Date("2026-12-01T10:00:00.000Z"),
        reference: `PV-REF-${Math.random().toString(36).slice(2, 8)}`,
        idempotencyKey: `pv-${Math.random().toString(36).slice(2, 10)}`,
        recordedById: adminId,
      },
    });
    transactionId = transaction.id;

    ctxHolder.current = { tenantId, userId: adminId, role: "admin", modules: ["admin"] };
  });

  it("reports a plain manual entry as declared and not confirmed", async () => {
    const result = await getTransactionProvenance(transactionId);
    expect(result.success, result.success ? "" : result.error).toBe(true);
    if (!result.success) return;
    expect(result.data.provenance.level).toBe("agent_declared");
    expect(result.data.provenance.providerConfirmed).toBe(false);
    expect(result.data.providerIntegrationAvailable).toBe(false);
  });

  it("records a device capture as a better-evidenced entry", async () => {
    await prisma.momoTransaction.update({
      where: { id: transactionId },
      data: { recordedDeviceId: "device-1", recordedDeviceName: "Counter phone" },
    });
    const result = await getTransactionProvenance(transactionId);
    if (!result.success) throw new Error(result.error);
    expect(result.data.provenance.level).toBe("device_captured");
    expect(result.data.provenance.providerConfirmed).toBe(false);
  });

  it("reads an imported statement match as a match, never as confirmation", async () => {
    const imp = await prisma.providerStatementImport.create({
      data: {
        tenantId,
        provider: "mtn",
        fileName: "statement.csv",
        fileHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
        status: "reconciled",
        importedById: adminId,
      },
    });
    await prisma.providerStatementRow.create({
      data: {
        tenantId,
        importId: imp.id,
        rowNumber: 1,
        fingerprint: `fp-${Math.random().toString(36).slice(2, 10)}`,
        externalReference: "MP-99881",
        status: "matched",
        matchedEntityType: "momoTransaction",
        matchedEntityId: transactionId,
        matchType: "exact_reference",
        matchedAt: new Date("2026-12-02T08:00:00.000Z"),
      },
    });

    const result = await getTransactionProvenance(transactionId);
    if (!result.success) throw new Error(result.error);
    expect(result.data.provenance.level).toBe("statement_matched");
    expect(result.data.provenance.providerConfirmed).toBe(false);
    expect(result.data.timeline.map((row) => row.label)).toContain(
      "Matched to an imported provider statement"
    );
  });

  it("counts an open exception case as an unsettled record", async () => {
    const kase = await prisma.reconciliationExceptionCase.create({
      data: {
        tenantId,
        caseNumber: `EX-${Math.random().toString(36).slice(2, 8)}`,
        category: "provider_statement",
        severity: "medium",
        status: "investigating",
        title: "Unmatched cash out",
        openedById: adminId,
      },
    });
    await prisma.reconciliationExceptionLink.create({
      data: {
        tenantId,
        caseId: kase.id,
        entityType: "momoTransaction",
        entityId: transactionId,
        createdById: adminId,
      },
    });

    const result = await getTransactionProvenance(transactionId);
    if (!result.success) throw new Error(result.error);
    expect(result.data.provenance.notes.join(" ")).toMatch(/nothing about it is settled yet/i);
    expect(result.data.timeline.map((row) => row.label)).toContain("Open reconciliation exception");
  });

  it("refuses another business's transaction without revealing it exists", async () => {
    const other = await prisma.businessTenant.create({
      data: {
        code: `PV2-${Math.random().toString(36).slice(2, 8)}`,
        name: "Other Tenant",
        status: "ACTIVE",
      },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: other.id,
        email: `pv2-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Other Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    ctxHolder.current = { tenantId: other.id, userId: otherAdmin.id, role: "admin", modules: ["admin"] };

    const result = await getTransactionProvenance(transactionId);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Transaction not found.");
  });
});
