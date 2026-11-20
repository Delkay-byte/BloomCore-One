"use server";

import { db } from "@/lib/db";
import { requireTenantAdminSusu, requireTenantCustomer } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  EVIDENCE_MAX_BYTES,
  isEvidenceSubjectType,
  isEvidenceContentType,
  removeEvidenceBytes,
  retentionDeadline,
  retentionElapsed,
  sanitizeFileName,
  storeEvidenceBytes,
  validateEvidence,
  type EvidenceSubjectType,
} from "@/lib/evidence";

/**
 * Evidence attachments for disputes and anomalies.
 *
 * A customer may attach a file only to their own dispute; an administrator may
 * attach to a subject in their own business. Nothing is accepted from a browser
 * without re-checking the subject, the file type and the size on the server.
 */

export interface EvidenceView {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  retentionUntil: string;
  uploadedByType: string;
}

export interface EvidenceResponse {
  success: boolean;
  error?: string;
  data?: EvidenceView;
  attachments?: EvidenceView[];
}

function toView(row: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
  retentionUntil: Date;
  uploadedByType: string;
}): EvidenceView {
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    uploadedAt: row.createdAt.toISOString(),
    retentionUntil: row.retentionUntil.toISOString(),
    uploadedByType: row.uploadedByType,
  };
}

/**
 * Confirm the caller may attach to this subject.
 *
 * A customer is limited to disputes they opened in their own business; an admin
 * is limited to their own business. The check reads the subject, so a forged
 * subject id fails here rather than producing an orphan file.
 */
async function authoriseSubject(
  subjectType: EvidenceSubjectType,
  subjectId: string
): Promise<{ tenantId: string; allowed: boolean; reason?: string; actor: "customer" | "admin" }> {
  if (subjectType === "customerDispute") {
    const customerCtx = await requireTenantCustomer().catch(() => null);
    if (customerCtx) {
      const dispute = await db.customerDispute.findFirst({
        where: { id: subjectId, customerId: customerCtx.userId, tenantId: customerCtx.tenantId },
        select: { id: true, status: true },
      });
      if (!dispute) {
        return {
          tenantId: customerCtx.tenantId,
          allowed: false,
          reason: "That dispute was not found.",
          actor: "customer",
        };
      }
      if (dispute.status === "cancelled") {
        return {
          tenantId: customerCtx.tenantId,
          allowed: false,
          reason: "A cancelled dispute cannot take new evidence.",
          actor: "customer",
        };
      }
      return { tenantId: customerCtx.tenantId, allowed: true, actor: "customer" };
    }
  }
  const adminCtx = await requireTenantAdminSusu();
  if (subjectType === "customerDispute") {
    const dispute = await db.customerDispute.findFirst({
      where: { id: subjectId, tenantId: adminCtx.tenantId },
      select: { id: true },
    });
    return {
      tenantId: adminCtx.tenantId,
      allowed: Boolean(dispute),
      reason: dispute ? undefined : "That dispute was not found.",
      actor: "admin",
    };
  }
  return { tenantId: adminCtx.tenantId, allowed: true, actor: "admin" };
}

export async function uploadEvidence(input: {
  subjectType: EvidenceSubjectType;
  subjectId: string;
  fileName: string;
  contentType: string;
  /** Raw file bytes from the browser form. */
  bytes: Uint8Array;
}): Promise<EvidenceResponse> {
  if (!isEvidenceSubjectType(input.subjectType)) {
    return { success: false, error: "That kind of record cannot take evidence." };
  }
  if (!isEvidenceContentType(input.contentType)) {
    return { success: false, error: "Attach a JPEG, PNG, WebP image or a PDF." };
  }
  if (input.bytes.byteLength > EVIDENCE_MAX_BYTES) {
    return {
      success: false,
      error: `That file is larger than ${Math.round(EVIDENCE_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }
  const fileName = sanitizeFileName(input.fileName);
  const validation = validateEvidence({
    fileName,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
  });
  if (!validation.ok) return { success: false, error: validation.error };

  const auth = await authoriseSubject(input.subjectType, input.subjectId);
  if (!auth.allowed) {
    return { success: false, error: auth.reason ?? "You cannot attach evidence here." };
  }

  const stored = await storeEvidenceBytes({
    tenantId: auth.tenantId,
    bytes: input.bytes,
    contentType: input.contentType,
  });
  const now = new Date();
  const row = await db.$transaction(async (tx) => {
    const created = await tx.evidenceAttachment.create({
      data: {
        tenantId: auth.tenantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        fileName,
        contentType: input.contentType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storageKey: stored.storageKey,
        uploadedById: (await callerId()).id,
        uploadedByType: auth.actor,
        retentionUntil: retentionDeadline(now),
      },
    });
    await createAuditLogTx(tx, {
      userId: (await callerId()).id,
      tenantId: auth.tenantId,
      action: "evidence.attached",
      entityType: input.subjectType,
      entityId: input.subjectId,
      details: {
        evidenceId: created.id,
        fileName,
        contentType: input.contentType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        financialMutation: false,
      },
    });
    return created;
  });

  return { success: true, data: toView(row) };
}

/** The signed-in user for the audit row, whichever module they are in. */
async function callerId(): Promise<{ id: string }> {
  const customer = await requireTenantCustomer().catch(() => null);
  if (customer) return { id: customer.userId };
  const admin = await requireTenantAdminSusu();
  return { id: admin.userId };
}

export async function getEvidenceForSubject(
  subjectType: EvidenceSubjectType,
  subjectId: string
): Promise<EvidenceResponse> {
  const auth = await authoriseSubject(subjectType, subjectId);
  if (!auth.allowed) {
    return { success: false, error: auth.reason ?? "Evidence is not available here." };
  }
  const rows = await db.evidenceAttachment.findMany({
    where: {
      tenantId: auth.tenantId,
      subjectType,
      subjectId,
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      sha256: true,
      createdAt: true,
      retentionUntil: true,
      uploadedByType: true,
    },
  });
  return { success: true, attachments: rows.map(toView) };
}

/**
 * Dispose of an expired attachment.
 *
 * Refused while the retention period is still running, and refused while the
 * dispute is open, because evidence that may still be needed must not vanish.
 */
export async function disposeEvidence(evidenceId: string): Promise<EvidenceResponse> {
  const ctx = await requireTenantAdminSusu();
  const row = await db.evidenceAttachment.findFirst({
    where: { id: evidenceId, tenantId: ctx.tenantId },
  });
  if (!row) return { success: false, error: "That attachment was not found." };
  if (!retentionElapsed(row.retentionUntil)) {
    return {
      success: false,
      error: "This attachment is still inside its retention period.",
    };
  }
  if (row.subjectType === "customerDispute") {
    const dispute = await db.customerDispute.findFirst({
      where: { id: row.subjectId, tenantId: ctx.tenantId },
      select: { status: true },
    });
    const openStatuses = ["open", "under_review", "awaiting_customer"];
    if (dispute && openStatuses.includes(dispute.status)) {
      return {
        success: false,
        error: "This dispute is still open, so its evidence must be kept.",
      };
    }
  }

  await removeEvidenceBytes(row.storageKey);
  await db.$transaction(async (tx) => {
    await tx.evidenceAttachment.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), deletedById: ctx.userId },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "evidence.disposed",
      entityType: row.subjectType,
      entityId: row.subjectId,
      details: {
        evidenceId: row.id,
        sha256: row.sha256,
        financialMutation: false,
      },
    });
  });
  return { success: true };
}
