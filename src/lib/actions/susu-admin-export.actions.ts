/**
 * Phase 8 — controlled administrative exports.
 *
 * The staff directory is personal data, so this export is:
 *   - administrator-only inside the tenant;
 *   - branch-scoped: a branch manager exports only staff who share a branch;
 *   - step-up protected (a fresh password confirmation);
 *   - rate-limited;
 *   - audited before the file leaves the server;
 *   - generated with the shared CSV escaping, so it is spreadsheet-safe.
 *
 * The tenant support export lives with the support actions because it obeys
 * the same visibility rules as the support pages.
 */

"use server";

import { db } from "@/lib/db";
import { getAdminSession } from "@/lib/auth";
import { createAuditLogTx } from "@/lib/audit";
import { requireTenantAdminSusu } from "@/lib/tenant";
import { resolveBranchScope, isCompanyWideAdmin } from "@/lib/branch";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  claimStepUpGrant,
  stepUpSessionBinding,
  StepUpDeniedError,
} from "@/lib/security/step-up";
import { buildCsv } from "@/lib/csv";

export interface StaffExportResult {
  success: boolean;
  error?: string;
  csv?: string;
  filename?: string;
  rowCount?: number;
}

export async function exportStaffDirectoryCsv(input: {
  stepUpToken?: string;
}): Promise<StaffExportResult> {
  const ctx = await requireTenantAdminSusu();
  const session = await getAdminSession();

  const burst = await consumeRateLimit(
    "admin:staff_export:burst",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminExportBurst
  );
  const sustained = await consumeRateLimit(
    "admin:staff_export",
    ctx.tenantId + ":" + ctx.userId,
    RATE_LIMITS.adminExportSustained
  );
  if (!burst.allowed || !sustained.allowed) {
    return { success: false, error: "Too many exports. Please wait before exporting again." };
  }

  const companyWide = await isCompanyWideAdmin(ctx);
  const scope = await resolveBranchScope(ctx);

  const memberships = await db.branchMembership.findMany({
    where: { tenantId: ctx.tenantId },
    select: { userId: true, locationId: true, role: true, status: true },
  });
  const collectors = await db.collector.findMany({
    where: { tenantId: ctx.tenantId },
    select: { userId: true, branchId: true, status: true },
  });
  const collectorByUser = new Map(collectors.map((row) => [row.userId, row]));

  const visibleUserIds = new Set<string>([ctx.userId]);
  if (companyWide) {
    visibleUserIds.clear();
  } else if (scope.kind === "limited") {
    for (const row of memberships) {
      if (roleInScope(scope.branchIds, row.locationId) && row.status === "active") {
        visibleUserIds.add(row.userId);
      }
    }
    for (const row of collectors) {
      if (row.branchId && scope.branchIds.includes(row.branchId)) visibleUserIds.add(row.userId);
    }
  }

  const users = await db.user.findMany({
    where: {
      tenantId: ctx.tenantId,
      role: { in: ["admin", "worker", "collector"] },
      ...(companyWide ? {} : { id: { in: Array.from(visibleUserIds) } }),
    },
    orderBy: [{ status: "asc" }, { fullName: "asc" }],
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  const sessionCounts = await db.sessionRecord.groupBy({
    by: ["subjectId"],
    where: {
      subjectType: "user",
      subjectId: { in: users.map((row) => row.id) },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    _count: { _all: true },
  });
  const sessionsByUser = new Map(sessionCounts.map((row) => [row.subjectId, row._count._all]));

  const locationIds = Array.from(new Set(memberships.map((row) => row.locationId)));
  const locations = locationIds.length
    ? await db.location.findMany({
        where: { tenantId: ctx.tenantId, id: { in: locationIds } },
        select: { id: true, name: true },
      })
    : [];
  const locationNames = new Map(locations.map((row) => [row.id, row.name]));
  const membershipsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    if (row.status !== "active") continue;
    const list = membershipsByUser.get(row.userId) ?? [];
    list.push((locationNames.get(row.locationId) ?? "Unknown branch") + " (" + row.role + ")");
    membershipsByUser.set(row.userId, list);
  }

  const rows: unknown[][] = [
    [
      "Full name",
      "Email",
      "Phone",
      "Role",
      "Status",
      "Branch access",
      "Collector status",
      "Active sessions",
      "Joined (UTC)",
    ],
    ...users.map((user) => [
      user.fullName,
      user.email,
      user.phone ?? "",
      user.role,
      user.status,
      (membershipsByUser.get(user.id) ?? []).join("; "),
      collectorByUser.get(user.id)?.status ?? "",
      sessionsByUser.get(user.id) ?? 0,
      user.createdAt.toISOString(),
    ]),
  ];
  const csv = buildCsv(rows);

  try {
    await db.$transaction(async (tx) => {
      const grant = await claimStepUpGrant(tx, {
        token: input?.stepUpToken,
        subjectType: "user",
        subjectId: ctx.userId,
        sessionId: stepUpSessionBinding(session, ctx.userId),
        purpose: "admin.export",
        targetType: "dataset",
        targetId: "staff_directory",
      });
      if (!grant.ok) throw new StepUpDeniedError(grant.error);

      await createAuditLogTx(tx, {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        action: "user.staff_directory_exported",
        entityType: "user",
        details: {
          rowCount: users.length,
          scope: companyWide ? "company" : "branch",
          format: "csv",
        },
      });
    });
  } catch (error) {
    if (error instanceof StepUpDeniedError) return { success: false, error: error.message };
    throw error;
  }

  const fileDate = new Date().toISOString().slice(0, 10);
  return {
    success: true,
    csv,
    filename: "staff-directory-" + fileDate + ".csv",
    rowCount: users.length,
  };
}

function roleInScope(branchIds: string[], locationId: string): boolean {
  return branchIds.includes(locationId);
}
