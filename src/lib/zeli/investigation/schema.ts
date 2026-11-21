/**
 * The only shape an AI investigation draft may take.
 *
 * A draft is rejected unless it is strict JSON, names the finding it explains, cites
 * only approved sources, and every number it states appears in the evidence pack.
 * Facts and hypotheses are separate arrays with separate statement kinds, so a guess
 * cannot be read as a measurement.
 */

import { z } from "zod";
import type { EvidenceSource, InvestigationEvidence } from "./evidence";
import { isAllowedRef } from "./evidence";

export const DRAFT_PROMPT_VERSION = "anomaly-explanation-p1";
export const DRAFT_SCHEMA_VERSION = "anomaly-draft-v1";

export const MAX_STATEMENTS = 12;
export const MAX_TIMELINE = 20;

const citation = z.object({
  sourceRef: z.string().min(3, "Every statement must cite an approved source."),
});

export const factSchema = citation.extend({
  text: z.string().trim().min(8, "A fact must say something checkable.").max(400),
  /** The values this fact relies on. Each must exist in the evidence pack. */
  values: z.array(z.number()).max(8).default([]),
});

export const hypothesisSchema = citation.extend({
  text: z.string().trim().min(8).max(400),
  confidence: z.enum(["low", "medium"]),
  because: z.string().trim().min(8).max(300),
});

export const timelineEntrySchema = z.object({
  at: z.string().datetime(),
  description: z.string().trim().min(3).max(300),
  sourceRef: z.string().min(3),
});

export const draftSchema = z.object({
  findingId: z.string().min(1),
  schemaVersion: z.literal(DRAFT_SCHEMA_VERSION),
  promptVersion: z.literal(DRAFT_PROMPT_VERSION),
  facts: z.array(factSchema).min(1).max(MAX_STATEMENTS),
  hypotheses: z.array(hypothesisSchema).max(MAX_STATEMENTS),
  missingEvidence: z.array(z.string().trim().min(3).max(200)).max(MAX_STATEMENTS),
  timeline: z.array(timelineEntrySchema).max(MAX_TIMELINE),
  investigationQuestions: z.array(z.string().trim().min(5).max(300)).max(MAX_STATEMENTS),
  nextSteps: z.array(z.string().trim().min(5).max(300)).max(MAX_STATEMENTS),
  limitations: z.array(z.string().trim().min(5).max(300)).min(1),
  modelMetadata: z.object({
    kind: z.enum(["deterministic", "external"]),
    model: z.string().max(80),
    /** Never a probability of wrongdoing. */
    advisoryOnly: z.literal(true),
  }),
});

export type InvestigationDraftPayload = z.infer<typeof draftSchema>;

export interface DraftValidation {
  ok: boolean;
  errors: string[];
  payload?: InvestigationDraftPayload;
}

/** Every number the pack contains, so grounding can be checked by value. */
export function evidenceNumbers(evidence: InvestigationEvidence): Set<number> {
  const values = new Set<number>();
  const add = (value: number | null | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    values.add(Math.round(value * 100) / 100);
    values.add(Math.round(value));
  };
  add(evidence.metric.measured);
  add(evidence.metric.threshold);
  for (const source of evidence.sources) {
    for (const value of Object.values(source.fields)) {
      if (typeof value === "number") add(value);
    }
  }
  return values;
}

/**
 * Validate a draft against the evidence it claims to explain.
 *
 * Rejections are specific, because a vague rejection cannot be acted on: an unknown
 * finding, an unapproved citation, a number nobody measured, or a hypothesis dressed
 * up as a fact each fail on their own line.
 */
export function validateDraft(input: {
  raw: unknown;
  evidence: InvestigationEvidence;
}): DraftValidation {
  const errors: string[] = [];
  const parsed = draftSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`
      ),
    };
  }
  const payload = parsed.data;

  if (payload.findingId !== input.evidence.findingId) {
    errors.push(
      `findingId: the draft explains ${payload.findingId}, which is not this finding.`
    );
  }

  const approved: EvidenceSource[] = input.evidence.sources;
  const numbers = evidenceNumbers(input.evidence);

  for (const [index, fact] of payload.facts.entries()) {
    if (!isAllowedRef(fact.sourceRef, approved)) {
      errors.push(`facts.${index}.sourceRef: "${fact.sourceRef}" is not approved evidence.`);
    }
    for (const value of fact.values) {
      const rounded = Math.round(value * 100) / 100;
      if (!numbers.has(rounded) && !numbers.has(Math.round(value))) {
        errors.push(`facts.${index}.values: ${value} was not measured in this evidence.`);
      }
    }
  }

  for (const [index, hypothesis] of payload.hypotheses.entries()) {
    if (!isAllowedRef(hypothesis.sourceRef, approved)) {
      errors.push(
        `hypotheses.${index}.sourceRef: "${hypothesis.sourceRef}" is not approved evidence.`
      );
    }
  }

  for (const [index, entry] of payload.timeline.entries()) {
    if (!isAllowedRef(entry.sourceRef, approved)) {
      errors.push(`timeline.${index}.sourceRef: "${entry.sourceRef}" is not approved evidence.`);
    }
  }

  if (!payload.limitations.some((line) => line.length >= 5)) {
    errors.push("limitations: a draft must state at least one limitation.");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], payload };
}

/**
 * Numbers mentioned in free text, used to catch an ungrounded figure in prose.
 *
 * A draft can pass the structure check and still say "GH₵8,000 is missing" in a
 * sentence; this finds those and lets the caller reject them.
 */
export function numericClaims(text: string): number[] {
  const withoutDates = text
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, " ")
    .replace(/[a-z_]+:[A-Za-z0-9_-]+/gi, " ");
  const matches = withoutDates.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches
    .map((token) => Number(token.replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));
}

export function ungroundedClaims(
  payload: InvestigationDraftPayload,
  evidence: InvestigationEvidence
): string[] {
  const numbers = evidenceNumbers(evidence);
  const problems: string[] = [];
  const check = (text: string, where: string) => {
    for (const value of numericClaims(text)) {
      const rounded = Math.round(value * 100) / 100;
      if (!numbers.has(rounded) && !numbers.has(Math.round(value))) {
        problems.push(`${where}: ${value} is not in the evidence.`);
      }
    }
  };
  payload.facts.forEach((fact, index) => check(fact.text, `facts.${index}`));
  payload.hypotheses.forEach((row, index) => check(row.text, `hypotheses.${index}`));
  payload.nextSteps.forEach((row, index) => check(row, `nextSteps.${index}`));
  return problems;
}
