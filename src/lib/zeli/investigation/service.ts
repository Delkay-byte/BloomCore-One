/**
 * Building the evidence pack and the draft for one finding.
 *
 * The queries are tenant-scoped and allow-listed: each source row contributes only
 * the fields a reader needs to check the arithmetic. The pack is hashed, the draft is
 * validated against it, and nothing is written until both succeed.
 */

import { db } from "@/lib/db";
import { ANOMALY_RULE_CATALOG } from "@/lib/anomaly-rules";
import {
  EVIDENCE_PACK_VERSION,
  assertMinimised,
  packHash,
  personPseudonym,
  sha256,
  sourceRef,
  type EvidenceSource,
  type EvidenceTimelineEntry,
  type InvestigationEvidence,
} from "./evidence";
import { buildDeterministicDraft } from "./deterministic";
import {
  DRAFT_PROMPT_VERSION,
  DRAFT_SCHEMA_VERSION,
  ungroundedClaims,
  validateDraft,
  type InvestigationDraftPayload,
} from "./schema";

/** The kill switch. A single value stops every generation in the product. */
export function investigationDisabled(): boolean {
  return (process.env.ZELI_INVESTIGATION_DISABLED ?? "").trim() === "1";
}

/**
 * External generation is not approved for production.
 *
 * The constant is checked before the environment, so setting an env var alone can
 * never enable a provider that has not passed a security and financial-evidence
 * review. This mirrors PRODUCTION_PROVIDER_APPROVED and
 * PRODUCTION_CONVERSATION_APPROVED, which stay false.
 */
export const PRODUCTION_INVESTIGATION_APPROVED = false;

export function externalGenerationAllowed(): boolean {
  return PRODUCTION_INVESTIGATION_APPROVED;
}

function ruleLabel(ruleKey: string): string {
  return ANOMALY_RULE_CATALOG.find((rule) => rule.key === ruleKey)?.label ?? ruleKey;
}

function ruleCalculation(ruleKey: string): string {
  const rule = ANOMALY_RULE_CATALOG.find((row) => row.key === ruleKey);
  return rule?.description ?? "The rule compares the measured value with its threshold.";
}

function fieldSource(
  type: EvidenceSource["type"],
  id: string,
  label: string,
  fields: EvidenceSource["fields"]
): EvidenceSource {
  return {
    ref: sourceRef(type, id),
    type,
    label,
    fields,
    hash: sha256(JSON.stringify(fields)),
  };
}

export interface EvidenceResult {
  success: boolean;
  error?: string;
  data?: InvestigationEvidence;
}

/**
 * Assemble the pack for one finding.
 *
 * Missing evidence is a first-class result, not an afterthought: a finding with no
 * source rows, no investigation and no prior events says so, and a pack that carries
 * personal data is refused rather than silently redacted.
 */
export async function buildEvidenceForFinding(
  tenantId: string,
  anomalyId: string
): Promise<EvidenceResult> {
  const finding = await db.operationalAnomaly.findFirst({
    where: { id: anomalyId, tenantId },
  });
  if (!finding) return { success: false, error: "Finding not found." };

  const [location, worker, investigation, events, drafts] = await Promise.all([
    finding.locationId
      ? db.location.findFirst({
          where: { id: finding.locationId, tenantId },
          select: { id: true, name: true, code: true },
        })
      : Promise.resolve(null),
    finding.workerId
      ? db.user.findFirst({
          where: { id: finding.workerId, tenantId },
          select: { id: true, role: true, locationId: true },
        })
      : Promise.resolve(null),
    db.anomalyInvestigation.findFirst({
      where: { anomalyId, tenantId },
      select: { id: true, status: true, disposition: true, dueAt: true },
    }),
    db.anomalyFindingEvent.findMany({
      where: { anomalyId, tenantId },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, kind: true, summary: true, createdAt: true, snapshotHash: true },
    }),
    db.anomalyInvestigationDraft.count({ where: { anomalyId, tenantId } }),
  ]);

  const sources: EvidenceSource[] = [
    fieldSource("operational_anomaly", finding.id, `Finding: ${ruleLabel(finding.ruleKey)}`, {
      ruleKey: finding.ruleKey,
      severity: finding.severity,
      status: finding.status,
      metricValue: finding.metricValue === null ? null : Number(finding.metricValue),
      thresholdValue: finding.thresholdValue === null ? null : Number(finding.thresholdValue),
      businessDate: finding.businessDate ? finding.businessDate.toISOString().slice(0, 10) : null,
      snapshotHash: finding.snapshotHash,
    }),
  ];

  const timeline: EvidenceTimelineEntry[] = [];

  const related: Array<{ type: EvidenceSource["type"]; id: string }> = [];
  if (finding.entityType === "dailyAccount") related.push({ type: "daily_account", id: finding.entityId });
  if (finding.entityType === "momoTransaction") {
    related.push({ type: "momo_transaction", id: finding.entityId });
  }
  if (finding.entityType === "branchTransfer") {
    related.push({ type: "branch_transfer", id: finding.entityId });
  }
  if (finding.entityType === "shiftHandover") {
    related.push({ type: "shift_handover", id: finding.entityId });
  }

  for (const item of related) {
    if (item.type === "daily_account") {
      const row = await db.dailyAccount.findFirst({
        where: { id: item.id, tenantId },
        select: {
          id: true,
          businessDate: true,
          status: true,
          openingCash: true,
          closingCash: true,
          openingMomoFloat: true,
          closingMomoFloat: true,
          calculatedCashVariance: true,
          calculatedMomoVariance: true,
          calculatedDifference: true,
          commission: true,
          totalExpenses: true,
          ledgerMode: true,
          submittedAt: true,
        },
      });
      if (row) {
        sources.push(
          fieldSource("daily_account", row.id, "Daily close for the affected day", {
            businessDate: row.businessDate.toISOString().slice(0, 10),
            status: row.status,
            openingCash: Number(row.openingCash),
            closingCash: Number(row.closingCash),
            openingFloat: Number(row.openingMomoFloat),
            closingFloat: Number(row.closingMomoFloat),
            cashVariance: Number(row.calculatedCashVariance),
            floatVariance: Number(row.calculatedMomoVariance),
            difference: Number(row.calculatedDifference),
            commission: Number(row.commission),
            expenses: Number(row.totalExpenses),
            ledgerMode: row.ledgerMode,
          })
        );
        timeline.push({
          at: (row.submittedAt ?? row.businessDate).toISOString(),
          kind: "daily_close",
          description: `Daily close recorded with status ${row.status}.`,
          sourceRef: sourceRef("daily_account", row.id),
        });
      }
    }
    if (item.type === "momo_transaction") {
      const row = await db.momoTransaction.findFirst({
        where: { id: item.id, tenantId },
        select: {
          id: true,
          type: true,
          network: true,
          direction: true,
          amount: true,
          status: true,
          businessDate: true,
          occurredAt: true,
          reference: true,
          reversesTransactionId: true,
        },
      });
      if (row) {
        sources.push(
          fieldSource("momo_transaction", row.id, "MoMo transaction in the finding", {
            type: row.type,
            network: row.network,
            direction: row.direction,
            amount: Number(row.amount),
            status: row.status,
            businessDate: row.businessDate.toISOString().slice(0, 10),
            reference: row.reference,
            isReversal: Boolean(row.reversesTransactionId),
          })
        );
        timeline.push({
          at: row.occurredAt.toISOString(),
          kind: "momo_transaction",
          description: `A ${row.type.replace(/_/g, " ")} of GHS ${Number(row.amount).toFixed(2)} was recorded.`,
          sourceRef: sourceRef("momo_transaction", row.id),
        });
      }
    }
    if (item.type === "branch_transfer") {
      const row = await db.branchTransfer.findFirst({
        where: { id: item.id, tenantId },
        select: {
          id: true,
          reference: true,
          assetType: true,
          amount: true,
          status: true,
          actualAmountReceived: true,
          variance: true,
          createdAt: true,
          dispatchedAt: true,
          receivedAt: true,
        },
      });
      if (row) {
        sources.push(
          fieldSource("branch_transfer", row.id, "Branch transfer in the finding", {
            assetType: row.assetType,
            amount: Number(row.amount),
            status: row.status,
            received: row.actualAmountReceived === null ? null : Number(row.actualAmountReceived),
            variance: row.variance === null ? null : Number(row.variance),
            reference: row.reference,
          })
        );
        timeline.push({
          at: (row.receivedAt ?? row.dispatchedAt ?? row.createdAt).toISOString(),
          kind: "branch_transfer",
          description: `A transfer of GHS ${Number(row.amount).toFixed(2)} is in status ${row.status}.`,
          sourceRef: sourceRef("branch_transfer", row.id),
        });
      }
    }
    if (item.type === "shift_handover") {
      const row = await db.shiftHandover.findFirst({
        where: { id: item.id, tenantId },
        select: {
          id: true,
          status: true,
          cashVariance: true,
          floatVariance: true,
          createdAt: true,
          confirmedAt: true,
        },
      });
      if (row) {
        sources.push(
          fieldSource("shift_handover", row.id, "Shift handover in the finding", {
            status: row.status,
            cashVariance: Number(row.cashVariance),
            floatVariance: Number(row.floatVariance),
          })
        );
        timeline.push({
          at: (row.confirmedAt ?? row.createdAt).toISOString(),
          kind: "shift_handover",
          description: `A shift handover was recorded with status ${row.status}.`,
          sourceRef: sourceRef("shift_handover", row.id),
        });
      }
    }
  }

  if (investigation) {
    sources.push(
      fieldSource("investigation", investigation.id, "Investigation record", {
        status: investigation.status,
        disposition: investigation.disposition,
        dueAt: investigation.dueAt ? investigation.dueAt.toISOString().slice(0, 10) : null,
      })
    );
  }

  for (const event of events) {
    sources.push(
      fieldSource("finding_event", event.id, `Finding event: ${event.kind}`, {
        kind: event.kind,
        at: event.createdAt.toISOString(),
        snapshotHash: event.snapshotHash,
      })
    );
    // Deliberately not the event's free text: a summary or a note can contain a
    // person's name, and the explanation does not need it to explain arithmetic.
    timeline.push({
      at: event.createdAt.toISOString(),
      kind: event.kind,
      description: `The finding was ${event.kind.replace(/_/g, " ")}.`,
      sourceRef: sourceRef("finding_event", event.id),
    });
  }

  const missingEvidence: string[] = [];
  if (related.length === 0) {
    missingEvidence.push("The finding does not name a source record that can be opened.");
  } else if (sources.length === 1) {
    missingEvidence.push("The referenced source record was not found in this business.");
  }
  if (!investigation) missingEvidence.push("No investigation has been opened for this finding.");
  if (events.length === 0) missingEvidence.push("No finding history was recorded yet.");
  if (drafts > 0) missingEvidence.push("An earlier explanation exists and was not reused.");
  if (!finding.businessDate) missingEvidence.push("The finding has no business date.");

  const limitations = [
    "This explanation only knows the records listed here; it cannot see the physical count, the provider statement or what staff observed.",
    "A finding is a prompt to check a record. It is not proof that anything was done wrong.",
  ];

  const pack: Omit<InvestigationEvidence, "packHash"> = {
    version: EVIDENCE_PACK_VERSION,
    findingId: finding.id,
    ruleKey: finding.ruleKey,
    severity: finding.severity,
    status: finding.status,
    detectedAt: finding.detectedAt.toISOString(),
    lastSeenAt: finding.lastSeenAt.toISOString(),
    firstSeenAt: finding.firstSeenAt ? finding.firstSeenAt.toISOString() : null,
    businessDate: finding.businessDate ? finding.businessDate.toISOString().slice(0, 10) : null,
    metric: {
      measured: finding.metricValue === null ? null : Number(finding.metricValue),
      threshold: finding.thresholdValue === null ? null : Number(finding.thresholdValue),
      unit: finding.metricValue === null ? null : "GHS",
      calculation: ruleCalculation(finding.ruleKey),
    },
    context: {
      branchLabel: location?.name ?? null,
      employeeLabel: worker ? `Role: ${worker.role}` : null,
      workerPseudonym: finding.workerId ? personPseudonym(finding.workerId) : null,
    },
    sources,
    timeline,
    missingEvidence,
    limitations,
  };

  const evidence: InvestigationEvidence = { ...pack, packHash: packHash(pack) };
  const problems = assertMinimised(evidence);
  if (problems.length > 0) {
    return {
      success: false,
      error: `The evidence pack carries personal data and was refused: ${problems.join("; ")}`,
    };
  }
  return { success: true, data: evidence };
}

export interface DraftResult {
  success: boolean;
  error?: string;
  data?: { payload: InvestigationDraftPayload; evidenceHash: string; source: "deterministic" | "external"; model: string };
}

/**
 * Produce a validated draft from a pack.
 *
 * The external provider is refused while `PRODUCTION_INVESTIGATION_APPROVED` is
 * false, and a kill switch stops even the deterministic explanation. Whatever the
 * path, the draft is validated and grounded before returning, and a rejected draft
 * returns its reasons rather than a partial answer.
 */
export async function generateDraftForEvidence(
  evidence: InvestigationEvidence
): Promise<DraftResult> {
  if (investigationDisabled()) {
    return { success: false, error: "AI investigation is switched off for this deployment." };
  }

  const source = externalGenerationAllowed() ? "external" : "deterministic";
  const model = source === "external" ? "not-configured" : "rules-only";
  const payload = buildDeterministicDraft(evidence);

  const validation = validateDraft({ raw: payload, evidence });
  if (!validation.ok || !validation.payload) {
    return { success: false, error: `The draft was rejected: ${validation.errors.join(" ")}` };
  }
  const ungrounded = ungroundedClaims(validation.payload, evidence);
  if (ungrounded.length > 0) {
    return { success: false, error: `The draft states unmeasured values: ${ungrounded.join(" ")}` };
  }

  return {
    success: true,
    data: { payload: validation.payload, evidenceHash: evidence.packHash, source, model },
  };
}

export const DRAFT_VERSIONS = {
  promptVersion: DRAFT_PROMPT_VERSION,
  schemaVersion: DRAFT_SCHEMA_VERSION,
};
