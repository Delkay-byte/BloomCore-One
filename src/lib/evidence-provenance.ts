/**
 * Closed-loop evidence provenance.
 *
 * One transaction, one honest answer to "how do we know this?".
 *
 * The product already keeps the pieces: the operator's entry, a device capture, an
 * uploaded evidence file, an imported provider statement row, a reconciliation
 * exception, an anomaly finding, a correction or reversal. This module puts them in
 * order and gives each claim a strength, so an owner never has to guess whether a
 * number was declared by a person or confirmed by a network.
 *
 * The rule that matters most: **nothing here can invent provider confirmation.** The
 * only input that produces `provider_confirmed` is a fact that says an authenticated
 * provider record exists for this transaction. A screenshot, a typed reference, an
 * imported CSV row or an AI explanation cannot produce it.
 */

export const EVIDENCE_PROVENANCE_VERSION = "anomaly-provenance-v1";

/** Ordered from weakest to strongest. A record's level is the strongest it reaches. */
export const PROVENANCE_LEVELS = [
  "agent_declared",
  "device_captured",
  "evidence_attached",
  "statement_matched",
  "provider_confirmed",
] as const;

export type ProvenanceLevel = (typeof PROVENANCE_LEVELS)[number];

export const PROVENANCE_LABELS: Record<ProvenanceLevel, string> = {
  agent_declared: "Declared by an employee",
  device_captured: "Captured on a device",
  evidence_attached: "Supporting evidence attached",
  statement_matched: "Matched to an imported provider statement",
  provider_confirmed: "Confirmed by the provider",
};

/**
 * What the reader is told each level does and does not mean. Written for an owner, not
 * for an auditor, because a label nobody understands is a label nobody trusts.
 */
export const PROVENANCE_EXPLANATIONS: Record<ProvenanceLevel, string> = {
  agent_declared:
    "Someone typed this into MaaCash. The figures are only as good as that person's record-keeping.",
  device_captured:
    "The record was captured on a device, so it carries the device, the employee and the time it was written.",
  evidence_attached:
    "A file, a reference or a note was attached. It supports the record; it does not prove a network completed anything.",
  statement_matched:
    "This matched a row in a provider statement the business imported. The match was made by MaaCash's rules and can be reviewed.",
  provider_confirmed:
    "An authenticated provider record confirms this transaction. This is the only state that means the network itself reported it.",
};

export interface ProvenanceFacts {
  /** The record exists in MaaCash's own books. */
  recorded: boolean;
  /** It was captured on a device (offline capture or counter companion). */
  deviceCaptured: boolean;
  /** Count of attached evidence files or references, tenant-scoped. */
  evidenceCount: number;
  /** A provider statement row is matched to it. */
  statementMatched: boolean;
  /**
   * An authenticated provider *record* exists for it — an approved integration, not an
   * imported CSV. Nothing in this repository can set this today, which is the point.
   */
  providerRecordConfirmed: boolean;
  /** A correction or reversal supersedes it. */
  corrected: boolean;
  /** An open reconciliation exception or anomaly refers to it. */
  openInvestigation: boolean;
}

export interface ProvenanceResult {
  /** Strongest level reached, or null when nothing is recorded. */
  level: ProvenanceLevel | null;
  labels: ProvenanceLevel[];
  explanation: string;
  /** True only when a provider record confirmed it. */
  providerConfirmed: boolean;
  /** Things a reader should know, in plain language. */
  notes: string[];
  /** The next thing that would strengthen this record, if any. */
  nextStep: string | null;
}

/**
 * Derive the provenance of one record from facts already gathered in its tenant.
 *
 * Deliberately pure: the evaluation cannot query anything itself, so it cannot be
 * tricked into reading a row from another business, and it is exhaustively testable.
 */
export function deriveProvenance(facts: ProvenanceFacts): ProvenanceResult {
  if (!facts.recorded) {
    return {
      level: null,
      labels: [],
      explanation: "This transaction is not in this business's records.",
      providerConfirmed: false,
      notes: [],
      nextStep: null,
    };
  }

  const labels: ProvenanceLevel[] = ["agent_declared"];
  if (facts.deviceCaptured) labels.push("device_captured");
  if (facts.evidenceCount > 0) labels.push("evidence_attached");
  if (facts.statementMatched) labels.push("statement_matched");
  // Only an authenticated provider record may reach the top level.
  if (facts.providerRecordConfirmed) labels.push("provider_confirmed");

  const level = labels[labels.length - 1] ?? "agent_declared";
  const notes: string[] = [];

  if (facts.corrected) {
    notes.push(
      "This record was corrected or reversed. The original entry is kept, and the correction carries its own author and time."
    );
  }
  if (facts.openInvestigation) {
    notes.push(
      "An open reconciliation exception or anomaly refers to this record. Nothing about it is settled yet."
    );
  }
  if (facts.statementMatched && !facts.providerRecordConfirmed) {
    notes.push(
      "The match was made against a statement the business imported. An imported file is evidence the business kept, not a live confirmation from the network."
    );
  }
  if (!facts.providerRecordConfirmed) {
    notes.push(
      "No network integration confirmed this transaction. MaaCash will not describe it as confirmed until one does."
    );
  }

  let nextStep: string | null = null;
  if (!facts.providerRecordConfirmed) {
    if (!facts.statementMatched) {
      nextStep =
        "Import the provider statement for this day and match the row, or attach the evidence you kept at the counter.";
    } else if (facts.evidenceCount === 0) {
      nextStep = "Attach the counter evidence for this transaction so the match can be reviewed later.";
    } else {
      nextStep = null;
    }
  }

  return {
    level,
    labels,
    explanation: PROVENANCE_EXPLANATIONS[level],
    providerConfirmed: facts.providerRecordConfirmed,
    notes,
    nextStep,
  };
}

/**
 * The ordered story of one record, so a reader sees the sequence rather than a badge.
 */
export interface ProvenanceTimelineEntry {
  at: string | null;
  actor: string | null;
  label: string;
  detail: string | null;
  /** Never true for an internal event. */
  providerConfirmed: boolean;
}

export function orderProvenanceTimeline(
  entries: ProvenanceTimelineEntry[]
): ProvenanceTimelineEntry[] {
  return [...entries].sort((a, b) => {
    // An event with no timestamp cannot be placed in the story, so it goes last rather
    // than pretending it happened at the epoch.
    const left = a.at ? new Date(a.at).getTime() : Number.POSITIVE_INFINITY;
    const right = b.at ? new Date(b.at).getTime() : Number.POSITIVE_INFINITY;
    return left - right;
  });
}

/** A record that claims provider confirmation without the supporting fact is a bug. */
export function assertNoUnsupportedConfirmation(result: ProvenanceResult, facts: ProvenanceFacts): void {
  if (result.providerConfirmed && !facts.providerRecordConfirmed) {
    throw new Error("Provenance claimed provider confirmation without a provider record.");
  }
}
