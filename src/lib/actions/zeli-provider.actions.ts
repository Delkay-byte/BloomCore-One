"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  PRODUCTION_PROVIDER_APPROVED,
  TEAM_TESTING_APPROVED,
  TEAM_TESTING_DISCLOSURE_VERSION,
  deepSeekModel,
  getEffectiveProviderPolicy,
  getProviderControl,
  providerStatusMessage,
  syntheticTestingEnabled,
  teamTestingEnvAllowed,
  teamTestingTenantCode,
} from "@/lib/zeli/provider-control";
import { buildSyntheticInsightPackage } from "@/lib/zeli/insight-package";
import { evaluateInsightPackage, INSIGHT_SCHEMA_VERSION } from "@/lib/zeli/gateway";
import { requestDeepSeekExplanation } from "@/lib/zeli/deepseek-client";
import { requestDeepSeekConnectionProbe } from "@/lib/zeli/providers/deepseek-conversation";
import {
  providerRequestId,
  recordProviderUsage,
} from "@/lib/zeli/provider-audit";

export interface ProviderActionResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

async function requirePlatformRead() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

async function requirePlatformWrite() {
  const session = await requirePlatformRead();
  const rate = await consumeRateLimit(
    "platform.zeli.provider",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

async function audit(
  session: { adminId: string; email: string },
  action: string,
  reason: string,
  details?: Record<string, unknown>,
  entityType = "zeli_provider_control",
  entityId = "global"
) {
  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action,
    entityType,
    entityId,
    reason,
    details: details ?? null,
  });
}

export async function getZeliProviderControlState() {
  await requirePlatformRead();
  const control = await getProviderControl();
  const policy = await getEffectiveProviderPolicy();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    usage,
    denied,
    successes,
    failures,
    tenantAuthorizations,
    tenants,
    teamTesters,
    lastSuccess,
    lastFailure,
    lastRequest,
    totalUsage,
  ] = await Promise.all([
    db.zeliProviderUsage.count({ where: { createdAt: { gte: since } } }),
    db.zeliProviderUsage.count({
      where: { createdAt: { gte: since }, decision: "denied" },
    }),
    db.zeliProviderUsage.count({
      where: { createdAt: { gte: since }, decision: "success" },
    }),
    db.zeliProviderUsage.count({
      where: { createdAt: { gte: since }, decision: "error" },
    }),
    db.zeliAiTenantAuthorization.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { tenant: { select: { code: true, name: true } } },
    }),
    db.businessTenant.findMany({
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, code: true, name: true },
    }),
    db.zeliTeamTester.findMany({ orderBy: { updatedAt: "desc" }, take: 100 }),
    db.zeliProviderUsage.findFirst({
      where: { decision: "success" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.zeliProviderUsage.findFirst({
      where: { decision: "error" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.zeliProviderUsage.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.zeliProviderUsage.count(),
  ]);
  const testerUserIds = [...new Set(teamTesters.map((row) => row.userId))];
  const testerUsers = testerUserIds.length
    ? await db.user.findMany({
        where: { id: { in: testerUserIds } },
        select: { id: true, email: true, fullName: true, tenantId: true },
      })
    : [];
  const userMap = new Map(testerUsers.map((row) => [row.id, row]));
  const expectedTeamCode = teamTestingTenantCode();
  const teamTenant = tenants.find((row) => row.code === expectedTeamCode) ?? null;
  const teamTenantAuthorization = teamTenant
    ? tenantAuthorizations.find((row) => row.tenantId === teamTenant.id) ?? null
    : null;
  const disclosureMatched =
    control.policyVersion === TEAM_TESTING_DISCLOSURE_VERSION;
  const teamMembers = teamTenant
    ? await db.user.findMany({
        where: { tenantId: teamTenant.id, status: "active" },
        orderBy: { fullName: "asc" },
        take: 100,
        select: { id: true, email: true, fullName: true, role: true },
      })
    : [];

  return {
    control,
    policy,
    message: providerStatusMessage(policy),
    productionCodeApproved: PRODUCTION_PROVIDER_APPROVED,
    teamCodeApproved: TEAM_TESTING_APPROVED,
    syntheticEnvAllowed: syntheticTestingEnabled(),
    teamEnvAllowed: teamTestingEnvAllowed(),
    teamTenantCode: expectedTeamCode,
    teamTenantId: teamTenant?.id ?? null,
    teamTenantName: teamTenant?.name ?? null,
    teamTenantAuthorized: Boolean(teamTenantAuthorization?.enabled),
    teamMembers,
    teamDisclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
    teamDisclosureMatched: disclosureMatched,
    teamTesters: teamTesters.map((row) => {
      const user = userMap.get(row.userId);
      return {
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId,
        email: user?.email ?? null,
        fullName: user?.fullName ?? null,
        status: row.status,
        disclosureVersion: row.disclosureVersion,
        disclosureAcceptedAt: row.disclosureAcceptedAt?.toISOString() ?? null,
        reason: row.reason,
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    model: deepSeekModel(),
    usage24h: { total: usage, denied, successes, failures },
    usageTotals: {
      total: totalUsage,
      lastSuccessAt: lastSuccess?.createdAt.toISOString() ?? null,
      lastFailureAt: lastFailure?.createdAt.toISOString() ?? null,
      lastRequestAt: lastRequest?.createdAt.toISOString() ?? null,
    },
    tenants: tenants.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    tenantAuthorizations: tenantAuthorizations.map((row) => ({
      tenantId: row.tenantId,
      tenantCode: row.tenant.code,
      tenantName: row.tenant.name,
      enabled: row.enabled,
      reason: row.reason,
      approvedAt: row.approvedAt?.toISOString() ?? null,
    })),
  };
}

/** Switch between disabled and synthetic testing. Approved production is locked. */
export async function setZeliProviderMode(input: {
  mode: "disabled" | "synthetic" | "team_testing" | "approved";
  reason: string;
}): Promise<ProviderActionResponse> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  if (input.mode === "approved") {
    if (!PRODUCTION_PROVIDER_APPROVED) {
      return {
        success: false,
        error:
          "Approved production processing is locked by the reviewed code policy. A code change, privacy approval and environment approval are required.",
      };
    }
    return {
      success: false,
      error:
        "Production activation is not implemented for platform toggles. Complete the documented approval procedure.",
    };
  }
  if (input.mode === "synthetic" && !syntheticTestingEnabled()) {
    return {
      success: false,
      error:
        "Synthetic provider testing is not enabled in this environment (ZELI_SYNTHETIC_TESTING_ALLOWED).",
    };
  }
  if (input.mode === "team_testing") {
    if (!TEAM_TESTING_APPROVED) {
      return {
        success: false,
        error: "Team Testing is locked by the reviewed code policy.",
      };
    }
    if (!teamTestingEnvAllowed()) {
      return {
        success: false,
        error:
          "Team Testing is not enabled in this environment (ZELI_TEAM_TESTING_ALLOWED).",
      };
    }
  }
  if (
    input.mode !== "disabled" &&
    input.mode !== "synthetic" &&
    input.mode !== "team_testing"
  ) {
    return { success: false, error: "Unknown provider mode." };
  }

  const disabled = input.mode === "disabled";
  const policyVersion =
    input.mode === "team_testing" ? TEAM_TESTING_DISCLOSURE_VERSION : "2026-11.2";
  await db.zeliProviderControl.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      mode: input.mode,
      enabled: !disabled,
      emergencyDisabled: disabled,
      approvedProvider: disabled ? null : "deepseek",
      approvedPurposes: JSON.stringify([
        "period_comparison",
        "trend_explanation",
        "chart_explanation",
        "operational_summary",
        "branch_comparison",
        "remittance_pattern",
        "exception_explanation",
      ]),
      policyVersion,
      reason,
      updatedById: session.adminId,
    },
    update: {
      mode: input.mode,
      enabled: !disabled,
      // The emergency stop is a latch. It is never cleared by a mode change,
      // including switching modes: only clearZeliProviderEmergencyStop may
      // clear it, and clearing it does not enable the provider.
      approvedProvider: disabled ? null : "deepseek",
      policyVersion,
      reason,
      updatedById: session.adminId,
    },
  });
  await audit(
    session,
    disabled
      ? "zeli.provider_disabled"
      : input.mode === "team_testing"
        ? "zeli.provider_team_testing_enabled"
        : "zeli.provider_synthetic_enabled",
    reason,
    { mode: input.mode, policyVersion }
  );
  return { success: true };
}

/**
 * Clear the latched emergency stop after an explicit, audited decision.
 *
 * This never enables external AI: the mode is forced to disabled so the
 * operator must make a separate, deliberate synthetic switch afterwards.
 */
export async function clearZeliProviderEmergencyStop(
  reason: string
): Promise<ProviderActionResponse> {
  const session = await requirePlatformWrite();
  const clean = (reason ?? "").trim();
  if (clean.length < 10 || clean.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const control = await getProviderControl();
  if (!control.emergencyDisabled) {
    return { success: false, error: "The emergency stop is not active." };
  }
  const clearedAt = new Date();
  await db.zeliProviderControl.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      mode: "disabled",
      enabled: false,
      emergencyDisabled: false,
      reason: clean,
      updatedById: session.adminId,
    },
    update: {
      mode: "disabled",
      enabled: false,
      emergencyDisabled: false,
      reason: clean,
      updatedById: session.adminId,
    },
  });
  await audit(session, "zeli.provider_emergency_cleared", clean, {
    previousState: {
      emergencyDisabled: true,
      mode: control.mode,
      enabled: control.enabled,
    },
    newState: {
      emergencyDisabled: false,
      mode: "disabled",
      enabled: false,
    },
    clearedAt: clearedAt.toISOString(),
  });
  return { success: true };
}

/** Immediate global stop. Overrides every other setting. */
export async function emergencyDisableZeliProvider(
  reason: string
): Promise<ProviderActionResponse> {
  const session = await requirePlatformWrite();
  const clean = (reason ?? "").trim();
  if (clean.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  await db.zeliProviderControl.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      mode: "disabled",
      enabled: false,
      emergencyDisabled: true,
      reason: clean,
      updatedById: session.adminId,
    },
    update: {
      mode: "disabled",
      enabled: false,
      emergencyDisabled: true,
      reason: clean,
      updatedById: session.adminId,
    },
  });
  await audit(session, "zeli.provider_emergency_disabled", clean);
  return { success: true };
}

export async function setTenantZeliAiAuthorization(input: {
  tenantId: string;
  enabled: boolean;
  reason: string;
}): Promise<ProviderActionResponse> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { code: true },
  });
  if (!tenant) return { success: false, error: "Business not found." };
  await db.zeliAiTenantAuthorization.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      enabled: input.enabled,
      reason,
      approvedById: session.adminId,
      approvedAt: input.enabled ? new Date() : null,
    },
    update: {
      enabled: input.enabled,
      reason,
      approvedById: session.adminId,
      approvedAt: input.enabled ? new Date() : null,
    },
  });
  await audit(
    session,
    input.enabled ? "zeli.ai_tenant_authorized" : "zeli.ai_tenant_authorization_removed",
    reason,
    { tenantId: input.tenantId, tenantCode: tenant.code }
  );
  return { success: true };
}

/**
 * Explicit synthetic connectivity probe. Sends a fixed synthetic package only;
 * no tenant data can enter this path. Requires synthetic mode and environment
 * permission.
 */
export async function runSyntheticDeepSeekProbe(reason: string): Promise<
  ProviderActionResponse<{
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    model: string;
    explanation: string;
  }>
> {
  const session = await requirePlatformWrite();
  const clean = (reason ?? "").trim();
  if (clean.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const policy = await getEffectiveProviderPolicy();
  if (policy.state !== "synthetic" || !policy.allowed) {
    return { success: false, error: "Synthetic provider testing is not enabled." };
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    return { success: false, error: "No server-side provider credential is configured." };
  }
  const pkg = buildSyntheticInsightPackage();
  const gateway = evaluateInsightPackage(pkg, { cohortSize: 42, synthetic: true });
  if (!gateway.ok) {
    return { success: false, error: "The synthetic package failed gateway validation." };
  }
  const requestId = providerRequestId();
  try {
    const result = await requestDeepSeekExplanation({
      package: pkg,
      policy,
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    await recordProviderUsage({
      requestId,
      tenantId: null,
      userId: session.adminId,
      roleCategory: "platform_admin",
      provider: "deepseek",
      model: policy.model,
      purpose: "synthetic_probe",
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "success",
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
    });
    await audit(session, "zeli.provider_synthetic_probe", clean, {
      latencyMs: result.latencyMs,
      model: policy.model,
    });
    return {
      success: true,
      data: {
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: policy.model,
        explanation: result.explanation.explanation,
      },
    };
  } catch (error) {
    await recordProviderUsage({
      requestId,
      tenantId: null,
      userId: session.adminId,
      roleCategory: "platform_admin",
      provider: "deepseek",
      model: policy.model,
      purpose: "synthetic_probe",
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "error",
      reasonCategory: error instanceof Error ? error.name : "provider_error",
    });
    return {
      success: false,
      error:
        "The synthetic provider probe failed. Check the key, network and provider status. No tenant data was sent.",
    };
  }
}

/**
 * Grant or revoke restricted team-testing access for one member of the
 * configured team-testing tenant. This is separate from production tenant
 * authorization and never enables approved production processing.
 */
export async function setZeliTeamTesterAccess(input: {
  tenantId: string;
  userId: string;
  enabled: boolean;
  reason: string;
}): Promise<ProviderActionResponse> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, name: true },
  });
  if (!tenant) return { success: false, error: "Business not found." };
  if (tenant.code !== teamTestingTenantCode()) {
    return {
      success: false,
      error: `Team Testing is restricted to ${teamTestingTenantCode()}.`,
    };
  }
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, tenantId: true, email: true, role: true, status: true },
  });
  if (!user || user.tenantId !== tenant.id || user.status !== "active") {
    return { success: false, error: "Active team member not found in this business." };
  }

  const row = await db.zeliTeamTester.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    create: {
      tenantId: tenant.id,
      userId: user.id,
      status: input.enabled ? "active" : "revoked",
      reason,
      grantedById: input.enabled ? session.adminId : null,
      revokedById: input.enabled ? null : session.adminId,
    },
    update: {
      status: input.enabled ? "active" : "revoked",
      reason,
      grantedById: input.enabled ? session.adminId : undefined,
      revokedById: input.enabled ? null : session.adminId,
      // A fresh grant must be accepted again by the member.
      ...(input.enabled
        ? { disclosureVersion: null, disclosureAcceptedAt: null }
        : {}),
    },
  });
  await audit(
    session,
    input.enabled ? "zeli.team_tester_granted" : "zeli.team_tester_revoked",
    reason,
    {
      tenantId: tenant.id,
      tenantCode: tenant.code,
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    "zeli_team_tester",
    row.id
  );
  return { success: true };
}

/**
 * Test the DeepSeek credential with a harmless fixed prompt. This proves real
 * API connectivity; it does not prove conversational routing or send any tenant
 * data.
 */
export async function runDeepSeekConnectionTest(reason: string): Promise<
  ProviderActionResponse<{
    latencyMs: number;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    response: string;
  }>
> {
  const session = await requirePlatformWrite();
  const clean = (reason ?? "").trim();
  if (clean.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const control = await getProviderControl();
  if (control.emergencyDisabled) {
    return {
      success: false,
      error: "The emergency stop is active. Clear it before testing the provider.",
    };
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    return { success: false, error: "No server-side provider credential is configured." };
  }
  const model = deepSeekModel();
  const requestId = providerRequestId();
  try {
    const result = await requestDeepSeekConnectionProbe({
      apiKey: process.env.DEEPSEEK_API_KEY,
      model,
    });
    await recordProviderUsage({
      requestId,
      tenantId: null,
      userId: session.adminId,
      roleCategory: "platform_admin",
      provider: "deepseek",
      model,
      purpose: "team_connection_test",
      schemaVersion: "zeli-team-testing-v1",
      decision: "success",
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
    });
    await audit(session, "zeli.team_connection_tested", clean, {
      latencyMs: result.latencyMs,
      model,
    });
    return {
      success: true,
      data: {
        latencyMs: result.latencyMs,
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        response: result.text,
      },
    };
  } catch {
    await recordProviderUsage({
      requestId,
      tenantId: null,
      userId: session.adminId,
      roleCategory: "platform_admin",
      provider: "deepseek",
      model,
      purpose: "team_connection_test",
      schemaVersion: "zeli-team-testing-v1",
      decision: "error",
      reasonCategory: "connection_test_failed",
    });
    return {
      success: false,
      error:
        "DeepSeek connectivity test failed. Check the credential, network and provider status. No tenant data was sent.",
    };
  }
}
