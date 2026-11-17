"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { getTenantContext } from "@/lib/tenant";

/**
 * Residual C — in-app security alert queue.
 *
 * Alerts are scoped to the caller: a platform operator sees platform alerts, a
 * tenant administrator sees alerts for their own business plus alerts addressed
 * to them personally. No cross-tenant read is possible because the scope is
 * derived from the authenticated session, never from the request body.
 */

export interface SecurityAlertView {
  id: string;
  severity: string;
  title: string;
  body: string;
  event: string;
  createdAt: string;
  read: boolean;
}

interface AlertScope {
  audience: "platform" | "tenant_admin";
  tenantId: string | null;
  subjectType: "platform" | "user";
  subjectId: string;
}

async function resolveScope(): Promise<AlertScope | null> {
  const platform = await getPlatformAdminOrNull();
  if (platform) {
    return {
      audience: "platform",
      tenantId: null,
      subjectType: "platform",
      subjectId: platform.adminId,
    };
  }
  const ctx = await getTenantContext("admin");
  if (ctx && ctx.role === "admin") {
    return {
      audience: "tenant_admin",
      tenantId: ctx.tenantId,
      subjectType: "user",
      subjectId: ctx.userId,
    };
  }
  return null;
}

export async function getSecurityAlerts(): Promise<SecurityAlertView[]> {
  const scope = await resolveScope();
  if (!scope) return [];

  const rows = await db.securityAlert.findMany({
    where: {
      OR: [
        scope.audience === "platform"
          ? { audience: "platform" }
          : { audience: "tenant_admin", tenantId: scope.tenantId },
        { audience: "subject", subjectType: scope.subjectType, subjectId: scope.subjectId },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      severity: true,
      title: true,
      body: true,
      event: true,
      createdAt: true,
      readAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    event: row.event,
    createdAt: row.createdAt.toISOString(),
    read: row.readAt !== null,
  }));
}

export async function markSecurityAlertsRead(
  ids: string[]
): Promise<{ success: boolean }> {
  const scope = await resolveScope();
  if (!scope || !Array.isArray(ids) || ids.length === 0) {
    return { success: false };
  }
  const allowed = ids
    .filter((id): id is string => typeof id === "string" && id.length <= 64)
    .slice(0, 50);
  if (allowed.length === 0) return { success: false };

  await db.securityAlert.updateMany({
    where: {
      id: { in: allowed },
      OR: [
        scope.audience === "platform"
          ? { audience: "platform" }
          : { audience: "tenant_admin", tenantId: scope.tenantId },
        { audience: "subject", subjectType: scope.subjectType, subjectId: scope.subjectId },
      ],
    },
    data: { readAt: new Date() },
  });
  return { success: true };
}
