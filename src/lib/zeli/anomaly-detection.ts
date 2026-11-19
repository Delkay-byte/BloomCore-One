/**
 * Zeli anomaly triage — deterministic, explainable and advisory.
 *
 * This is deliberately NOT a model. Existing threshold findings from
 * `OperationalAnomaly` are grouped by the person or branch they belong to and
 * ordered with a fixed, published rule weight. The result is an attention
 * score, never a probability, credit score or fraud determination.
 *
 * There is no external provider call. A future model adapter must implement
 * `AnomalyScoringProvider` and remain unavailable until a reviewed data set,
 * false-positive process and owner approval exist.
 */

export type TriageSeverity = "high" | "medium" | "low";
export type TriageBand = "high" | "elevated" | "low";
export type TriageGroupKind = "employee" | "branch" | "unassigned";

export interface AnomalyTriageSignal {
  id: string;
  ruleKey: string;
  severity: TriageSeverity;
  status: string;
  workerId: string | null;
  workerName?: string | null;
  locationId: string | null;
  locationName?: string | null;
  detectedAt: string;
}

export interface AnomalyTriageGroup {
  key: string;
  kind: TriageGroupKind;
  label: string;
  signalCount: number;
  high: number;
  medium: number;
  low: number;
  score: number;
  band: TriageBand;
  ruleCounts: Array<{ ruleKey: string; count: number }>;
  reasons: string[];
}

export interface AnomalyTriageBriefing {
  provider: string;
  modelUsed: false;
  externalModel: false;
  signalsConsidered: number;
  score: number;
  band: TriageBand;
  headline: string;
  groups: AnomalyTriageGroup[];
  methodology: string;
  limitations: string[];
  generatedAt: string;
}

export interface AnomalyScoringProvider {
  id: string;
  externalModel: boolean;
  score(signals: AnomalyTriageSignal[], now?: Date): AnomalyTriageBriefing;
}

/** Fixed weights. They prioritise review order; they are not probabilities. */
export const TRIAGE_WEIGHTS = {
  high: 42,
  medium: 20,
  low: 7,
  /** Extra attention when the same person or branch repeats. */
  repeat: 8,
  repeatCap: 24,
  highBand: 70,
  elevatedBand: 35,
} as const;

const ACTIVE_STATUSES = new Set(["open", "acknowledged"]);

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function triageBand(score: number): TriageBand {
  if (score >= TRIAGE_WEIGHTS.highBand) return "high";
  if (score >= TRIAGE_WEIGHTS.elevatedBand) return "elevated";
  return "low";
}

function groupOf(signal: AnomalyTriageSignal): {
  key: string;
  kind: TriageGroupKind;
  label: string;
} {
  if (signal.workerId) {
    return {
      key: `employee:${signal.workerId}`,
      kind: "employee",
      label: signal.workerName?.trim() || "Assigned employee",
    };
  }
  if (signal.locationId) {
    return {
      key: `branch:${signal.locationId}`,
      kind: "branch",
      label: signal.locationName?.trim() || "Branch",
    };
  }
  return { key: "unassigned", kind: "unassigned", label: "Unassigned findings" };
}

function scoreGroup(
  key: string,
  kind: TriageGroupKind,
  label: string,
  signals: AnomalyTriageSignal[]
): AnomalyTriageGroup {
  const high = signals.filter((row) => row.severity === "high").length;
  const medium = signals.filter((row) => row.severity === "medium").length;
  const low = signals.filter((row) => row.severity === "low").length;
  const base =
    high * TRIAGE_WEIGHTS.high +
    medium * TRIAGE_WEIGHTS.medium +
    low * TRIAGE_WEIGHTS.low;
  const repeat = Math.min(
    TRIAGE_WEIGHTS.repeatCap,
    Math.max(0, signals.length - 1) * TRIAGE_WEIGHTS.repeat
  );
  const score = Math.min(100, round(base + repeat));

  const counts = new Map<string, number>();
  for (const signal of signals) {
    counts.set(signal.ruleKey, (counts.get(signal.ruleKey) ?? 0) + 1);
  }
  const ruleCounts = Array.from(counts.entries())
    .map(([ruleKey, count]) => ({ ruleKey, count }))
    .sort((a, b) => b.count - a.count || a.ruleKey.localeCompare(b.ruleKey));

  const reasons: string[] = [
    `${signals.length} active finding${signals.length === 1 ? "" : "s"}: ${high} high, ${medium} medium, ${low} low.`,
  ];
  if (signals.length > 1) {
    reasons.push(
      `Repeated findings for the same ${
        kind === "employee" ? "employee" : kind === "branch" ? "branch" : "record"
      } raise the attention score.`
    );
  }
  if (ruleCounts[0]) {
    reasons.push(
      `Most frequent rule: ${ruleCounts[0].ruleKey} (${ruleCounts[0].count}).`
    );
  }

  return {
    key,
    kind,
    label,
    signalCount: signals.length,
    high,
    medium,
    low,
    score,
    band: triageBand(score),
    ruleCounts,
    reasons,
  };
}

export function buildAnomalyTriage(
  input: AnomalyTriageSignal[],
  now: Date = new Date()
): AnomalyTriageBriefing {
  const active = input.filter((signal) => ACTIVE_STATUSES.has(signal.status));
  const buckets = new Map<string, AnomalyTriageSignal[]>();
  for (const signal of active) {
    const group = groupOf(signal);
    const rows = buckets.get(group.key) ?? [];
    rows.push(signal);
    buckets.set(group.key, rows);
  }

  const groups = Array.from(buckets.entries())
    .map(([key, signals]) => {
      const group = groupOf(signals[0]);
      return scoreGroup(key, group.kind, group.label, signals);
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.signalCount - a.signalCount ||
        a.label.localeCompare(b.label)
    )
    .slice(0, 10);

  const score = groups.reduce((highest, group) => Math.max(highest, group.score), 0);
  const band = triageBand(score);
  const top = groups[0];
  const headline =
    active.length === 0
      ? "No active findings to triage."
      : top
        ? `${top.label}: ${top.signalCount} active finding${
            top.signalCount === 1 ? "" : "s"
          }, attention ${top.band}.`
        : "No active findings to triage.";

  return {
    provider: "deterministic_rules",
    modelUsed: false,
    externalModel: false,
    signalsConsidered: active.length,
    score,
    band,
    headline,
    groups,
    methodology:
      "Fixed rule weights: high 42, medium 20, low 7, plus 8 per repeated finding for the same employee or branch (capped at 24). The total is capped at 100. High band starts at 70, elevated at 35.",
    limitations: [
      "This is an attention score for review order, not a probability of fraud, dishonesty or loss.",
      "It only re-orders existing threshold findings. It does not create findings or change their evidence.",
      "Resolved findings are excluded. Acknowledged findings remain in the score until resolved.",
      "No external model, machine learning service or customer data was used.",
    ],
    generatedAt: now.toISOString(),
  };
}

class DeterministicAnomalyScoringProvider implements AnomalyScoringProvider {
  readonly id = "deterministic_rules";
  readonly externalModel = false;

  score(signals: AnomalyTriageSignal[], now?: Date): AnomalyTriageBriefing {
    return buildAnomalyTriage(signals, now);
  }
}

const deterministicProvider = new DeterministicAnomalyScoringProvider();

/**
 * The only provider available today. A model-backed provider must not be wired
 * in without a reviewed model, a false-positive process and explicit owner
 * approval; it would also have to disclose that in `modelUsed`.
 */
export function getAnomalyScoringProvider(): AnomalyScoringProvider {
  return deterministicProvider;
}
