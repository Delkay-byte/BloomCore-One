"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  PRODUCTION_PROVIDER_APPROVED,
  deepSeekModel,
  getEffectiveProviderPolicy,
  getProviderControl,
  providerStatusMessage,
  syntheticTestingEnabled,
} from "@/lib/zeli/provider-control";
import { buildSyntheticInsightPackage } from "@/lib/zeli/insight-package";
import { evaluateInsightPackage, INSIGHT_SCHEMA_VERSION } from "@/lib/zeli/gateway";
import { requestDeepSeekExplanation } from "@/lib/zeli/deepseek-client";
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
  details?: Record<string, unknown>
) {
  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action,
    entityType: "zeli_provider_control",
    entityId: "global",
    reason,
    details: details ?? null,
  });
}

export async function getZeliProviderControlState() {
  await requirePlatformRead();
  const control = await getProviderControl();
  const policy = await getEffectiveProviderPolicy();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [usage, denied, successes, failures, tenantAuthorizations, tenants] = await Promise.all([
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
  ]);
  return {
    control,
    policy,
    message: providerStatusMessage(policy),
    productionCodeApproved: PRODUCTION_PROVIDER_APPROVED,
    syntheticEnvAllowed: syntheticTestingEnabled(),
    model: deepSeekModel(),
    usage24h: { total: usage, denied, successes, failures },
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
  mode: "disabled" | "synthetic" | "approved";
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
  if (input.mode !== "disabled" && input.mode !== "synthetic") {
    return { success: false, error: "Unknown provider mode." };
  }

  const disabled = input.mode === "disabled";
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
      policyVersion: "2026-11.2",
      reason,
      updatedById: session.adminId,
    },
    update: {
      mode: input.mode,
      enabled: !disabled,
      emergencyDisabled: disabled,
      approvedProvider: disabled ? null : "deepseek",
      reason,
      updatedById: session.adminId,
    },
  });
  await audit(session, disabled ? "zeli.provider_disabled" : "zeli.provider_synthetic_enabled", reason, {
    mode: input.mode,
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
