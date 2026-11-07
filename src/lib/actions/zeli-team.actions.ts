"use server";

import { db } from "@/lib/db";
import { getTenantContext } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { getZeliAvailability, UNAVAILABLE_MESSAGE } from "@/lib/zeli/availability";
import {
  TEAM_TESTING_DISCLOSURE_VERSION,
  teamTestingTenantCode,
} from "@/lib/zeli/provider-control";
import type { ZeliIdentity } from "@/lib/zeli/types";

/**
 * Record a team member's acceptance of the external-AI disclosure. This is
 * separate from platform grant/revoke and is required before the first live
 * DeepSeek conversation for that member.
 */
export async function acceptZeliTeamDisclosure(): Promise<{
  success: boolean;
  error?: string;
}> {
  if (!(await getZeliAvailability()).enabled) {
    return { success: false, error: UNAVAILABLE_MESSAGE };
  }

  let identity: ZeliIdentity | null = null;
  for (const moduleName of ["admin", "momo", "susu", "customer"] as const) {
    const ctx = await getTenantContext(moduleName);
    if (ctx) {
      identity = {
        userId: ctx.userId,
        fullName: "",
        role: ctx.role as ZeliIdentity["role"],
        tenantId: ctx.tenantId,
        module: moduleName,
      };
      break;
    }
  }
  if (!identity?.tenantId) return { success: false, error: "Not authenticated" };

  const tenant = await db.businessTenant.findUnique({
    where: { id: identity.tenantId },
    select: { code: true },
  });
  if (!tenant || tenant.code !== teamTestingTenantCode()) {
    return { success: false, error: "Team Testing is not available for this business." };
  }

  const tester = await db.zeliTeamTester.findUnique({
    where: {
      tenantId_userId: {
        tenantId: identity.tenantId,
        userId: identity.userId,
      },
    },
    select: { id: true, status: true },
  });
  if (!tester || tester.status !== "active") {
    return { success: false, error: "You are not authorised for Team Testing." };
  }

  await db.zeliTeamTester.update({
    where: { id: tester.id },
    data: {
      disclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
      disclosureAcceptedAt: new Date(),
    },
  });
  await createAuditLog({
    userId: identity.userId,
    action: "zeli.team_disclosure_accepted",
    entityType: "user",
    entityId: identity.userId,
    details: {
      tenantId: identity.tenantId,
      disclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
    },
  });
  return { success: true };
}
