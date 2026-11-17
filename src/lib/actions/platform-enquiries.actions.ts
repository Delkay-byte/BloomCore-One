"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePlatformPage } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import {
  ENQUIRY_STATUSES,
  type EnquiryRow,
} from "@/lib/pricing/enquiry-status";

/**
 * Platform review of prospective-customer enquiries.
 *
 * An enquiry is a lead. Converting one never creates a tenant, a login or a
 * subscription: provisioning and payment stay in their existing controlled
 * flows.
 */

export async function listAccountEnquiries(): Promise<EnquiryRow[]> {
  await requirePlatformPage();
  const rows = await db.accountEnquiry.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    businessName: row.businessName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    locationCount: row.locationCount,
    interestedPlan: row.interestedPlan,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function updateAccountEnquiryStatus(input: {
  id: string;
  status: string;
  notes?: string;
}): Promise<{ success: boolean; error?: string }> {
  const session = await requirePlatformPage();
  const status = String(input?.status ?? "");
  if (!(ENQUIRY_STATUSES as readonly string[]).includes(status)) {
    return { success: false, error: "Choose a valid enquiry status." };
  }
  const id = String(input?.id ?? "");
  const existing = await db.accountEnquiry.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Enquiry not found." };

  await db.accountEnquiry.update({
    where: { id },
    data: {
      status,
      notes: input.notes ? String(input.notes).slice(0, 2000) : existing.notes,
      reviewedById: session.adminId,
      reviewedAt: new Date(),
    },
  });

  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action: "platform.enquiry_status_updated",
    entityType: "account_enquiry",
    entityId: id,
    details: { from: existing.status, to: status },
    reason: input.notes ? String(input.notes).slice(0, 500) : undefined,
  });

  revalidatePath("/platform/enquiries");
  return { success: true };
}
