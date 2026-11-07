import { db } from "@/lib/db";
import { PROVIDER_DISABLED_MESSAGE, PROVIDER_POLICY_VERSION } from "./provider-policy";

/**
 * Single centralized external-AI policy.
 *
 * States:
 *   disabled  — no external request, ever
 *   synthetic — synthetic packages only, explicitly enabled in environment
 *   approved  — aggregate-only production processing, additionally gated by a
 *               reviewed code constant, privacy policy version, approval
 *               reference, provider configuration and tenant authorization
 *
 * The database switch cannot activate approved production mode by itself.
 */

/** Change only through a reviewed, privacy-approved code commit. */
export const PRODUCTION_PROVIDER_APPROVED = false;

/**
 * Team Testing is a separate, reviewed mode for genuine DeepSeek conversations
 * with fixed synthetic business fixtures. It never authorises production
 * processing and never sends tenant records.
 */
export const TEAM_TESTING_APPROVED = true;
export const TEAM_TESTING_DISCLOSURE_VERSION = "2026-11-team.1";
export const TEAM_TESTING_POLICY_VERSION = TEAM_TESTING_DISCLOSURE_VERSION;

export type ProviderMode =
  | "disabled"
  | "synthetic"
  | "team_testing"
  | "approved";

export interface ProviderControlRecord {
  mode: string;
  enabled: boolean;
  emergencyDisabled: boolean;
  approvedProvider: string | null;
  approvedPurposes: string[] | null;
  policyVersion: string | null;
  approvalReference: string | null;
  reason: string | null;
  updatedById: string | null;
  updatedAt: Date;
}

export interface EffectiveProviderPolicy {
  state: "disabled" | "synthetic" | "team_testing" | "approved";
  allowed: boolean;
  provider: "deepseek" | null;
  model: string;
  reason: string;
  syntheticOnly: boolean;
  productionApproved: boolean;
  emergencyDisabled: boolean;
  control: ProviderControlRecord;
  credentialConfigured: boolean;
  codeApprovalPresent: boolean;
  privacyVersionPresent: boolean;
  approvalReferencePresent: boolean;
  tenantAuthorized: boolean;
  teamCodeApprovalPresent?: boolean;
  teamEnvAllowed?: boolean;
  teamTenantCode?: string;
  teamTenantMatched?: boolean;
  teamTesterActive?: boolean;
  teamDisclosureAccepted?: boolean;
  teamDisclosureVersion?: string;
  teamDisclosureMatched?: boolean;
}

export const DEFAULT_CONTROL: ProviderControlRecord = {
  mode: "disabled",
  enabled: false,
  emergencyDisabled: true,
  approvedProvider: null,
  approvedPurposes: null,
  policyVersion: null,
  approvalReference: null,
  reason: null,
  updatedById: null,
  updatedAt: new Date(0),
};

export function deepSeekModel(): string {
  const configured = (process.env.DEEPSEEK_MODEL || "deepseek-flash").trim();
  return ["deepseek-flash", "deepseek-v4-pro"].includes(configured)
    ? configured
    : "deepseek-flash";
}

export async function getProviderControl(): Promise<ProviderControlRecord> {
  try {
    const row = await db.zeliProviderControl.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULT_CONTROL;
    let purposes: string[] | null = null;
    if (row.approvedPurposes) {
      try {
        const parsed = JSON.parse(row.approvedPurposes);
        purposes = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : null;
      } catch {
        purposes = null;
      }
    }
    return {
      mode: row.mode,
      enabled: row.enabled,
      emergencyDisabled: row.emergencyDisabled,
      approvedProvider: row.approvedProvider,
      approvedPurposes: purposes,
      policyVersion: row.policyVersion,
      approvalReference: row.approvalReference,
      reason: row.reason,
      updatedById: row.updatedById,
      updatedAt: row.updatedAt,
    };
  } catch {
    return DEFAULT_CONTROL;
  }
}

export async function getTenantAiAuthorization(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const row = await db.zeliAiTenantAuthorization.findUnique({ where: { tenantId } });
    return Boolean(row?.enabled);
  } catch {
    return false;
  }
}

export function syntheticTestingEnabled(): boolean {
  return process.env.ZELI_SYNTHETIC_TESTING_ALLOWED === "true";
}

/** Environment permission for the restricted live team-testing mode. */
export function teamTestingEnvAllowed(): boolean {
  return process.env.ZELI_TEAM_TESTING_ALLOWED === "true";
}

/** The only tenant allowed to use team testing unless explicitly reconfigured. */
export function teamTestingTenantCode(): string {
  return (process.env.ZELI_TEAM_TESTING_TENANT_CODE || "BIK-HQ-001").trim();
}

export async function getTeamTester(
  tenantId: string | null | undefined,
  userId: string | null | undefined
): Promise<{
  active: boolean;
  disclosureVersion: string | null;
  disclosureAcceptedAt: Date | null;
} | null> {
  if (!tenantId || !userId) return null;
  try {
    const row = await db.zeliTeamTester.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: {
        status: true,
        disclosureVersion: true,
        disclosureAcceptedAt: true,
      },
    });
    if (!row) return null;
    return {
      active: row.status === "active",
      disclosureVersion: row.disclosureVersion,
      disclosureAcceptedAt: row.disclosureAcceptedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Fail-closed evaluation. Every condition is additive; no single flag or key
 * can enable processing.
 */
export async function getEffectiveProviderPolicy(
  tenantId?: string | null,
  userId?: string | null
): Promise<EffectiveProviderPolicy> {
  const control = await getProviderControl();
  const credentialConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
  const codeApprovalPresent = PRODUCTION_PROVIDER_APPROVED;
  const privacyVersion = (process.env.ZELI_PRIVACY_POLICY_VERSION || "").trim();
  const approvalRef = (process.env.ZELI_APPROVAL_REFERENCE || "").trim();
  const privacyVersionPresent =
    Boolean(privacyVersion) && privacyVersion === control.policyVersion;
  const approvalReferencePresent = Boolean(approvalRef);
  const tenantAuthorized = tenantId ? await getTenantAiAuthorization(tenantId) : false;
  const expectedTeamTenantCode = teamTestingTenantCode();
  const tenantRecord = tenantId
    ? await db.businessTenant
        .findUnique({ where: { id: tenantId }, select: { code: true } })
        .catch(() => null)
    : null;
  const teamTenantMatched = Boolean(
    tenantRecord && tenantRecord.code === expectedTeamTenantCode
  );
  const tester = await getTeamTester(tenantId, userId);
  const teamTesterActive = Boolean(tester?.active);
  const teamDisclosureAccepted = Boolean(
    tester?.active &&
      tester.disclosureAcceptedAt &&
      tester.disclosureVersion === TEAM_TESTING_DISCLOSURE_VERSION
  );
  const teamDisclosureMatched =
    control.policyVersion === TEAM_TESTING_DISCLOSURE_VERSION;

  const base = {
    provider: "deepseek" as const,
    model: deepSeekModel(),
    control,
    credentialConfigured,
    codeApprovalPresent,
    privacyVersionPresent,
    approvalReferencePresent,
    tenantAuthorized,
    teamCodeApprovalPresent: TEAM_TESTING_APPROVED,
    teamEnvAllowed: teamTestingEnvAllowed(),
    teamTenantCode: expectedTeamTenantCode,
    teamTenantMatched,
    teamTesterActive,
    teamDisclosureAccepted,
    teamDisclosureVersion: TEAM_TESTING_DISCLOSURE_VERSION,
    teamDisclosureMatched,
  };

  if (control.emergencyDisabled) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "External AI is stopped by the global emergency disable control.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: true,
    };
  }
  if (!control.enabled || control.mode === "disabled") {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: PROVIDER_DISABLED_MESSAGE,
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }
  if (control.approvedProvider !== "deepseek") {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "No approved external provider is configured.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }
  if (!credentialConfigured) {
    return {
      ...base,
      state: "disabled",
      allowed: false,
      reason: "External provider credential is not configured. Zeli remains local.",
      syntheticOnly: false,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }

  if (control.mode === "team_testing") {
    const missing: string[] = [];
    if (!TEAM_TESTING_APPROVED) missing.push("reviewed team-testing code approval");
    if (!teamTestingEnvAllowed()) missing.push("team-testing environment permission");
    if (!teamDisclosureMatched) missing.push("team-testing disclosure version");
    if (!teamTenantMatched) missing.push(`team-testing tenant (${expectedTeamTenantCode})`);
    if (!tenantAuthorized) missing.push("tenant authorization");
    if (!teamTesterActive) missing.push("authorised team tester");
    if (!teamDisclosureAccepted) missing.push("tester disclosure acceptance");
    if (missing.length > 0) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason: `Team Testing is locked: missing ${missing.join(", ")}.`,
        syntheticOnly: true,
        productionApproved: false,
        emergencyDisabled: false,
      };
    }
    return {
      ...base,
      state: "team_testing",
      allowed: true,
      reason:
        "Team Testing is enabled: genuine DeepSeek conversations using synthetic business data only.",
      syntheticOnly: true,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }

  if (control.mode === "synthetic") {
    if (!syntheticTestingEnabled()) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason:
          "Synthetic provider testing is not enabled in this environment. Set ZELI_SYNTHETIC_TESTING_ALLOWED=true only in an approved test environment.",
        syntheticOnly: true,
        productionApproved: false,
        emergencyDisabled: false,
      };
    }
    return {
      ...base,
      state: "synthetic",
      allowed: true,
      reason: "Synthetic provider testing is enabled. Only synthetic insight packages may be sent.",
      syntheticOnly: true,
      productionApproved: false,
      emergencyDisabled: false,
    };
  }

  if (control.mode === "approved") {
    const missing: string[] = [];
    if (!codeApprovalPresent) missing.push("reviewed code approval");
    if (!privacyVersionPresent) missing.push("approved privacy policy version");
    if (!approvalReferencePresent) missing.push("approval reference");
    if (!tenantAuthorized) missing.push("tenant authorization");
    if (missing.length > 0) {
      return {
        ...base,
        state: "disabled",
        allowed: false,
        reason: `Aggregate production processing is locked: missing ${missing.join(", ")}.`,
        syntheticOnly: false,
        productionApproved: codeApprovalPresent,
        emergencyDisabled: false,
      };
    }
    return {
      ...base,
      state: "approved",
      allowed: true,
      reason: "Approved aggregate-only production processing is enabled.",
      syntheticOnly: false,
      productionApproved: true,
      emergencyDisabled: false,
    };
  }

  return {
    ...base,
    state: "disabled",
    allowed: false,
    reason: "Unsupported provider mode.",
    syntheticOnly: false,
    productionApproved: false,
    emergencyDisabled: false,
  };
}

export function providerStatusMessage(policy: EffectiveProviderPolicy): string {
  if (policy.state === "approved") {
    return "External AI is enabled for approved aggregate-only explanations.";
  }
  if (policy.state === "team_testing") {
    return "Team Testing is enabled: live DeepSeek conversations with synthetic business data only.";
  }
  if (policy.state === "synthetic") {
    return "External AI is in synthetic testing mode. No tenant records may be sent.";
  }
  return PROVIDER_DISABLED_MESSAGE;
}

export const PROVIDER_CONTROL_POLICY_VERSION = PROVIDER_POLICY_VERSION;
