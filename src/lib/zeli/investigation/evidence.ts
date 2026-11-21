/**
 * The evidence pack an AI explanation may see.
 *
 * Everything here is chosen, not dumped. A finding already knows its rule, its
 * measured value and its threshold; the pack adds the approved source records, the
 * hash of each one, role labels instead of people, and an explicit list of what is
 * missing. Nothing that is not in this pack may appear in an AI draft, and the
 * pack itself is what gets hashed and stored for review.
 */

import { createHash } from "node:crypto";

export const EVIDENCE_PACK_VERSION = "anomaly-evidence-v1";

/** Only these source types may be cited by a draft. */
export const ALLOWED_SOURCE_TYPES = [
  "operational_anomaly",
  "daily_account",
  "momo_transaction",
  "branch_transfer",
  "shift_handover",
  "finding_event",
  "investigation",
] as const;
export type SourceType = (typeof ALLOWED_SOURCE_TYPES)[number];

export interface EvidenceSource {
  /** Stable reference a draft must cite: `<type>:<id>`. */
  ref: string;
  type: SourceType;
  /** What the record is, in words a reviewer can check. */
  label: string;
  /** Allow-listed fields only. Never notes, names, phones or emails. */
  fields: Record<string, string | number | boolean | null>;
  /** SHA-256 of the canonical source payload. */
  hash: string;
}

export interface EvidenceTimelineEntry {
  at: string;
  kind: string;
  description: string;
  sourceRef: string;
}

export interface InvestigationEvidence {
  version: string;
  findingId: string;
  ruleKey: string;
  severity: string;
  status: string;
  detectedAt: string;
  lastSeenAt: string;
  firstSeenAt: string | null;
  businessDate: string | null;
  metric: {
    measured: number | null;
    threshold: number | null;
    unit: "GHS" | "count" | "minutes" | null;
    calculation: string;
  };
  /** Role labels, not identities. */
  context: {
    branchLabel: string | null;
    employeeLabel: string | null;
    workerPseudonym: string | null;
  };
  sources: EvidenceSource[];
  timeline: EvidenceTimelineEntry[];
  missingEvidence: string[];
  limitations: string[];
  /** Hash of the pack itself, stored with the draft. */
  packHash: string;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceRef(type: SourceType, id: string): string {
  return `${type}:${id}`;
}

export function isAllowedRef(ref: string, sources: EvidenceSource[]): boolean {
  return sources.some((source) => source.ref === ref);
}

/**
 * A stable pseudonym for a person.
 *
 * The AI never needs a name to explain an arithmetic finding, and a pseudonym keeps
 * a draft readable ("Operator 4f2a") without carrying personal data into a prompt.
 */
export function personPseudonym(userId: string): string {
  return `Operator ${sha256(userId).slice(0, 4)}`;
}

const PII_FIELD_PATTERN = /(phone|email|msisdn|name|address|ghana_card|tax_id|dob)/i;

/** Fields that must never reach a prompt. */
export function isPiiField(key: string): boolean {
  return PII_FIELD_PATTERN.test(key);
}

/**
 * Assert that a pack carries no personal data beyond a pseudonym.
 *
 * Called before every generation, so the guarantee is checked rather than assumed.
 */
export function assertMinimised(evidence: InvestigationEvidence): string[] {
  const problems: string[] = [];
  for (const source of evidence.sources) {
    for (const key of Object.keys(source.fields)) {
      if (isPiiField(key)) problems.push(`${source.ref} carries field "${key}"`);
    }
  }
  if (evidence.context.workerPseudonym && !/^Operator [0-9a-f]{4}$/.test(evidence.context.workerPseudonym)) {
    problems.push("the worker reference is not a pseudonym");
  }
  return problems;
}

export function packHash(evidence: Omit<InvestigationEvidence, "packHash">): string {
  return sha256(canonical(evidence));
}
