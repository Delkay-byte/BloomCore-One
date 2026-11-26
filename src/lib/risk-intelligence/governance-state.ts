/**
 * Server-side query-time facts for the Risk Intelligence safeguards.
 *
 * Every gate in this module is evaluated at query or contribution time, never
 * trust a cached client value and never expose another tenant's records.
 */

import { db } from "@/lib/db";
import { RISK_INTELLIGENCE_POLICY_VERSION } from "./policy";
import { riskIntelligenceConfigured } from "./hasher";
import { getRiskSecretProvider } from "./secret-provider";
import { REQUIRED_AGREEMENT_TYPES } from "./agreements";
import { resolveEffectiveNotice } from "./notice-resolution";

/** No control row means the deployment follows its existing configuration. */
export async function globalRiskEnabled(): Promise<boolean> {
  const control = await db.riskGlobalControl.findUnique({ where: { id: "global" } });
  return control ? control.enabled : riskIntelligenceConfigured();
}

/**
 * ENG-01: active, share-signals businesses that also have every required
 * agreement executed, are on the current policy, are not suspended or expelled,
 * and whose tenant is still active. Query-only businesses are never counted,
 * and exact counts are never returned to a caller.
 *
 * The tenant identifier is internal to this module. Callers receive only a
 * count or a membership test, never the cohort.
 */
export async function eligibleShareTenantIds(): Promise<string[]> {
  const consents = await db.riskIntelligenceConsent.findMany({
    where: {
      status: "active",
      scope: "share_signals",
      policyVersion: RISK_INTELLIGENCE_POLICY_VERSION,
      suspendedAt: null,
      expelledAt: null,
    },
    select: { tenantId: true, consentedAt: true },
    orderBy: { consentedAt: "desc" },
  });
  const ids = [
    ...new Set(consents.map((row) => row.tenantId).filter((id): id is string => Boolean(id))),
  ];
  if (ids.length === 0) return [];
  const [tenants, agreements] = await Promise.all([
    db.businessTenant.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true },
    }),
    db.participationAgreement.findMany({
      where: {
        tenantId: { in: ids },
        state: { in: ["executed", "active"] },
        type: { in: [...REQUIRED_AGREEMENT_TYPES] },
      },
      select: { tenantId: true, type: true },
    }),
  ]);
  const executedByTenant = new Map<string, Set<string>>();
  for (const row of agreements) {
    const set = executedByTenant.get(row.tenantId) ?? new Set<string>();
    set.add(row.type);
    executedByTenant.set(row.tenantId, set);
  }
  const activeTenants = new Set(tenants.map((row) => row.id));
  return ids.filter((id) => {
    if (!activeTenants.has(id)) return false;
    const types = executedByTenant.get(id);
    return Boolean(types && REQUIRED_AGREEMENT_TYPES.every((type) => types.has(type)));
  });
}

export async function eligibleNetworkSize(): Promise<number> {
  return (await eligibleShareTenantIds()).length;
}

export interface TenantRiskState {
  consentActive: boolean;
  policyCurrent: boolean;
  scope: "share_signals" | "query_only" | null;
  suspended: boolean;
  expelled: boolean;
  eligibilityVerified: boolean;
  controllerRegistrationChecked: boolean;
  agreementsExecuted: boolean;
  noticeEvidenceRecorded: boolean;
  noticeVerified: boolean;
}

/** All ENG-08 gates for one tenant, resolved from the database. */
export async function tenantRiskState(
  tenantId: string,
  subjectUserId?: string
): Promise<TenantRiskState> {
  const [consent, agreements, currentNotice] = await Promise.all([
    db.riskIntelligenceConsent.findFirst({
      where: { tenantId, status: "active" },
      orderBy: { consentedAt: "desc" },
    }),
    db.participationAgreement.findMany({
      where: { tenantId, state: { in: ["executed", "active"] } },
      select: { type: true },
    }),
    subjectUserId
      ? resolveEffectiveNotice(tenantId, subjectUserId)
      : Promise.resolve(null),
  ]);

  const executedTypes = new Set(agreements.map((row) => row.type));
  const agreementsExecuted = REQUIRED_AGREEMENT_TYPES.every((type) => executedTypes.has(type));

  const notice = currentNotice && subjectUserId
    ? await db.employeeNoticeAttestation.findFirst({
        where: {
          tenantId,
          userId: subjectUserId,
          noticeVersion: currentNotice.version,
          acknowledgementState: "acknowledged",
        },
        select: {
          policyVersion: true,
          documentSha256: true,
          deliveryEvidence: true,
          verified: true,
          issuedAt: true,
          deliveryMethod: true,
        },
      })
    : null;
  // Existing staff must have had the notice for at least 14 days before a
  // signal is contributed. A first-login portal acknowledgement is delivered at
  // engagement and is immediate. A failed delivery never counts: verified is
  // only true when acceptable evidence was checked.
  const fourteenDaysAgo = Date.now() - 14 * 86_400_000;
  const noticeLeadSatisfied = Boolean(
    notice &&
      (notice.deliveryMethod === "portal_acknowledgement" ||
        notice.issuedAt.getTime() <= fourteenDaysAgo)
  );
  const noticeVerified = Boolean(notice?.verified);
  const noticeEvidenceRecorded = Boolean(
    currentNotice &&
      notice &&
      noticeVerified &&
      noticeLeadSatisfied &&
      !currentNotice.provisional &&
      notice.policyVersion === RISK_INTELLIGENCE_POLICY_VERSION &&
      notice.documentSha256 === currentNotice.documentHash &&
      notice.deliveryEvidence
  );

  return {
    consentActive: Boolean(consent),
    policyCurrent: consent?.policyVersion === RISK_INTELLIGENCE_POLICY_VERSION,
    scope: consent?.scope === "query_only" ? "query_only" : consent ? "share_signals" : null,
    suspended: Boolean(consent?.suspendedAt),
    expelled: Boolean(consent?.expelledAt),
    eligibilityVerified: Boolean(consent?.eligibilityVerified),
    controllerRegistrationChecked: Boolean(consent?.controllerRegistrationChecked),
    agreementsExecuted,
    noticeEvidenceRecorded,
    noticeVerified,
  };
}

/** A freeze applies to every supported HMAC key version for the same subject. */
export async function subjectIsFrozen(subjectKeys: string[]): Promise<boolean> {
  if (subjectKeys.length === 0) return false;
  const freeze = await db.riskSubjectFreeze.findFirst({
    where: { subjectKey: { in: subjectKeys }, status: "frozen" },
    select: { id: true },
  });
  return Boolean(freeze);
}

/** Versions still eligible for matching. Metadata only; no secret is returned. */
export async function supportedKeyVersions(): Promise<number[]> {
  const rows = await db.riskKeyVersion.findMany({
    where: { status: { in: ["active", "previous"] } },
    select: { version: true },
  });
  if (rows.length === 0) return [getRiskSecretProvider().activeVersion()];
  return rows.map((row) => row.version);
}
