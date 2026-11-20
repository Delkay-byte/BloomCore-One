import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { hashEvidence, readEvidenceBytes } from "@/lib/evidence";

/**
 * Download one evidence file.
 *
 * A file is never served by a public path: this route re-resolves the caller,
 * checks that the attachment belongs to their business and that they may see the
 * subject, verifies the stored bytes still match the recorded digest, and records
 * the access. A customer can only reach their own dispute's evidence.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;
  if (!/^[\w-]{8,64}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }

  const customer = await getTenantContext("customer", "susu");
  const admin = customer ? null : await getTenantContext("admin", "susu");
  const ctx = customer ?? admin;
  if (!ctx) return new Response("Forbidden", { status: 403 });

  const row = await db.evidenceAttachment.findFirst({
    where: { id, tenantId: ctx.tenantId, deletedAt: null },
  });
  if (!row) return new Response("Not found", { status: 404 });

  if (row.subjectType === "customerDispute") {
    if (customer) {
      const dispute = await db.customerDispute.findFirst({
        where: { id: row.subjectId, customerId: ctx.userId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!dispute) return new Response("Not found", { status: 404 });
    } else {
      const dispute = await db.customerDispute.findFirst({
        where: { id: row.subjectId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!dispute) return new Response("Not found", { status: 404 });
    }
  } else if (customer) {
    // Only a dispute subject is reachable from the customer portal.
    return new Response("Forbidden", { status: 403 });
  }

  const bytes = await readEvidenceBytes(row.storageKey);
  if (!bytes) return new Response("Not found", { status: 404 });
  if (hashEvidence(bytes) !== row.sha256) {
    // The stored file no longer matches what was recorded. Refuse rather than
    // hand over altered evidence.
    return new Response("Evidence failed its integrity check", { status: 409 });
  }

  await createAuditLog({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    action: "evidence.accessed",
    entityType: row.subjectType,
    entityId: row.subjectId,
    details: {
      evidenceId: row.id,
      actorType: customer ? "customer" : "admin",
      financialMutation: false,
    },
  }).catch(() => null);

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${row.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
