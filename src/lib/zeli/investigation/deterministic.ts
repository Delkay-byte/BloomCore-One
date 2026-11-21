/**
 * The explanation that always works.
 *
 * When no external provider is approved — which is the only state production may be
 * in — the draft is assembled from the finding's own rule, values and sources. It is
 * not a summary of a summary: it is the same arithmetic a person would do by hand,
 * written in sentences, with a citation on every line.
 */

import type { InvestigationEvidence } from "./evidence";
import { DRAFT_PROMPT_VERSION, DRAFT_SCHEMA_VERSION, type InvestigationDraftPayload } from "./schema";

export function buildDeterministicDraft(evidence: InvestigationEvidence): InvestigationDraftPayload {
  const findingRef = `operational_anomaly:${evidence.findingId}`;
  const measured = evidence.metric.measured;
  const threshold = evidence.metric.threshold;
  const unit = evidence.metric.unit ?? "count";
  const money = evidence.metric.unit === "GHS";

  const format = (value: number | null): string => {
    if (value === null) return "not recorded";
    return money ? `GHS ${value.toFixed(2)}` : `${value} ${unit}`;
  };

  const facts: InvestigationDraftPayload["facts"] = [
    {
      sourceRef: findingRef,
      text: `The rule ${evidence.ruleKey} measured ${format(measured)} against a threshold of ${format(threshold)} for the recorded business day.`,
      values: [measured, threshold].filter((value): value is number => value !== null),
    },
  ];

  if (evidence.timeline.length > 0) {
    const first = evidence.timeline[0];
    facts.push({
      sourceRef: first.sourceRef,
      text: `The earliest approved record in the timeline is "${first.description}" recorded in the finding history.`,
      values: [],
    });
  }

  for (const source of evidence.sources.filter((row) => row.type !== "operational_anomaly").slice(0, 4)) {
    facts.push({
      sourceRef: source.ref,
      text: `${source.label} is part of this finding's evidence.`,
      values: [],
    });
  }

  return {
    findingId: evidence.findingId,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    promptVersion: DRAFT_PROMPT_VERSION,
    facts,
    hypotheses: [
      {
        sourceRef: findingRef,
        text: "The difference may come from a record that was entered on a different day than the money moved.",
        confidence: "low",
        because:
          "A timing difference is common when a close is submitted late, and this pack cannot see the physical count.",
      },
    ],
    missingEvidence: evidence.missingEvidence,
    timeline: evidence.timeline.slice(0, 20).map((entry) => ({
      at: entry.at,
      description: entry.description,
      sourceRef: entry.sourceRef,
    })),
    investigationQuestions: [
      "Does the physical count agree with the closing figure for this day?",
      "Was any transaction for this day recorded on a later date?",
      "Did anyone else use this operator's device or account that day?",
    ],
    nextSteps: [
      "Compare the closing figure with the count sheet signed for that day.",
      "Check the next day's opening balance for an equivalent correction.",
    ],
    limitations: [
      ...evidence.limitations,
      "This explanation repeats recorded arithmetic. It does not know what happened in the branch.",
    ],
    modelMetadata: {
      kind: "deterministic",
      model: "rules-only",
      advisoryOnly: true,
    },
  };
}
