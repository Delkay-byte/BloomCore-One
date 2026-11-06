import type { ZeliIdentity } from "./types";
import type { AnalyticsSnapshot } from "./intelligence/metrics";
import type { ClassifiedIntent } from "./intelligence/intents";
import type { ComposedAnswer } from "./intelligence/compose";
import { buildInsightPackage } from "./insight-package";
import { evaluateInsightPackage, INSIGHT_SCHEMA_VERSION } from "./gateway";
import { getEffectiveProviderPolicy } from "./provider-control";
import {
  checkProviderLimits,
  circuitState,
  providerRequestId,
  recordCircuitFailure,
  recordCircuitSuccess,
  recordProviderUsage,
} from "./provider-audit";
import { auditReference } from "./provider-audit";
import {
  DeepSeekClientError,
  requestDeepSeekExplanation,
} from "./deepseek-client";

export interface ProviderEnhancement {
  used: boolean;
  text: string;
  reason?: string;
  state?: "disabled" | "synthetic" | "approved";
}

/**
 * Optional external explanation for an already-computed local answer.
 *
 * This function never runs in disabled or synthetic mode for a normal user
 * request. It sends only the allow-listed aggregate insight package; the local
 * answer remains authoritative and is always returned if the provider fails.
 */
export async function enhanceWithProvider(params: {
  identity: ZeliIdentity;
  intent: ClassifiedIntent["intent"];
  snapshot: AnalyticsSnapshot;
  localAnswer: ComposedAnswer;
}): Promise<ProviderEnhancement> {
  if (params.identity.role !== "admin" || !params.identity.tenantId) {
    return { used: false, text: "", reason: "not_admin" };
  }
  const policy = await getEffectiveProviderPolicy(params.identity.tenantId);
  if (!policy.allowed || policy.state !== "approved") {
    return { used: false, text: "", reason: policy.reason, state: policy.state };
  }
  if (circuitState("deepseek") === "open") {
    return { used: false, text: "", reason: "circuit_open", state: policy.state };
  }

  const requestId = providerRequestId();
  const tenantHash = auditReference(params.identity.tenantId);
  const userHash = auditReference(params.identity.userId);
  const limits = await checkProviderLimits(tenantHash, userHash);
  if (!limits.allowed) {
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: "admin",
      provider: "deepseek",
      model: policy.model,
      purpose: params.intent,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "denied",
      reasonCategory: limits.reason,
    });
    return { used: false, text: "", reason: limits.reason, state: policy.state };
  }

  const pkg = buildInsightPackage(params.snapshot, params.intent);
  const approvedPurposes = policy.control.approvedPurposes;
  if (approvedPurposes && !approvedPurposes.includes(pkg.purpose)) {
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: "admin",
      provider: "deepseek",
      model: policy.model,
      purpose: params.intent,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "denied",
      reasonCategory: "purpose_not_approved",
    });
    return { used: false, text: "", reason: "purpose_not_approved", state: policy.state };
  }
  const cohortSize = Math.max(
    params.snapshot.totals.activeAccounts,
    params.snapshot.totals.transactionCount,
    params.snapshot.totals.newCustomers
  );
  const gateway = evaluateInsightPackage(pkg, { cohortSize, synthetic: false });
  if (!gateway.ok) {
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: "admin",
      provider: "deepseek",
      model: policy.model,
      purpose: params.intent,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "denied",
      reasonCategory: "gateway_rejected",
    });
    return { used: false, text: "", reason: "gateway_rejected", state: policy.state };
  }

  try {
    const result = await requestDeepSeekExplanation({
      package: pkg,
      policy,
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    });
    recordCircuitSuccess("deepseek");
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: "admin",
      provider: "deepseek",
      model: policy.model,
      purpose: params.intent,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "success",
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
    });
    const explanation = result.explanation;
    const text = [
      "[EXTERNAL EXPLANATION · VALIDATED · AGGREGATE-ONLY]",
      explanation.explanation,
      `Observed pattern: ${explanation.observedPattern}`,
      `Possible interpretation: ${explanation.interpretation}`,
      `Suggested investigation: ${explanation.suggestedInvestigation}`,
      `Limitations: ${explanation.limitations}`,
      "[AUTHORITATIVE FACTS] All amounts, counts and dates in the preceding local answer are calculated by BloomCore One. The external explanation cannot change them.",
    ].join("\n");
    return { used: true, text, state: policy.state };
  } catch (error) {
    recordCircuitFailure("deepseek");
    const code = error instanceof DeepSeekClientError ? error.code : "provider_error";
    await recordProviderUsage({
      requestId,
      tenantId: params.identity.tenantId,
      userId: params.identity.userId,
      roleCategory: "admin",
      provider: "deepseek",
      model: policy.model,
      purpose: params.intent,
      schemaVersion: INSIGHT_SCHEMA_VERSION,
      decision: "error",
      reasonCategory: code,
    });
    return { used: false, text: "", reason: code, state: policy.state };
  }
}
