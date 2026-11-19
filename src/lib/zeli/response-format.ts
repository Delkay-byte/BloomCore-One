/**
 * Presentation contract for Zeli answers.
 *
 * New answers carry typed sections in assistant metadata. Older answers stored
 * a bracketed machine vocabulary such as `[CALCULATED FACT]`; those labels are
 * translated here for display without rewriting the stored message.
 */

export type ZeliSectionKind =
  | "calculated_fact"
  | "detected_pattern"
  | "automated_interpretation"
  | "suggested_action"
  | "unverified_hypothesis";

export interface ZeliAnswerSection {
  kind: ZeliSectionKind;
  label: string;
  text: string;
}

export interface ZeliAnswerMeta {
  period: string | null;
  source: string | null;
  freshness: string | null;
  limitations: string[];
}

export const SECTION_LABELS: Record<ZeliSectionKind, string> = {
  calculated_fact: "Key figures",
  detected_pattern: "What changed",
  automated_interpretation: "How to read this",
  suggested_action: "Recommended next step",
  unverified_hypothesis: "Not established",
};

const LEGACY_TAGS: Array<[string, ZeliSectionKind]> = [
  ["CALCULATED FACT", "calculated_fact"],
  ["DETECTED PATTERN", "detected_pattern"],
  ["AUTOMATED INTERPRETATION", "automated_interpretation"],
  ["SUGGESTED ACTION", "suggested_action"],
  ["UNVERIFIED HYPOTHESIS", "unverified_hypothesis"],
];

export function isAnswerSection(value: unknown): value is ZeliAnswerSection {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.kind === "string" &&
    row.kind in SECTION_LABELS &&
    typeof row.label === "string" &&
    typeof row.text === "string"
  );
}

export function normaliseAnswerMeta(value: unknown): ZeliAnswerMeta | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const limitations = Array.isArray(row.limitations)
    ? row.limitations.filter((item): item is string => typeof item === "string")
    : [];
  return {
    period: typeof row.period === "string" ? row.period : null,
    source: typeof row.source === "string" ? row.source : null,
    freshness: typeof row.freshness === "string" ? row.freshness : null,
    limitations,
  };
}

export function normaliseSections(value: unknown): ZeliAnswerSection[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isAnswerSection).map((row) => ({
    kind: row.kind,
    label: SECTION_LABELS[row.kind],
    text: row.text,
  }));
}

/**
 * Translate a message written before structured sections existed. Returns
 * `null` when the message contains no legacy vocabulary, so plain prose is
 * rendered unchanged.
 */
export function parseLegacyAnswer(content: string): {
  sections: ZeliAnswerSection[];
  meta: ZeliAnswerMeta;
} | null {
  if (!/\[(CALCULATED FACT|DETECTED PATTERN|AUTOMATED INTERPRETATION|SUGGESTED ACTION|UNVERIFIED HYPOTHESIS)\]/.test(content)) {
    return null;
  }

  let limitations: string[] = [];
  const limit = content.match(/\[LIMITATIONS\]\s*([\s\S]*)$/);
  if (limit) {
    limitations = [limit[1].trim()].filter(Boolean);
  }
  let body = content.replace(/\[LIMITATIONS\][\s\S]*$/, "").trim();
  let period: string | null = null;
  let source: string | null = null;
  let freshness: string | null = null;

  const footer = body.match(
    /\[PERIOD\]\s*([^\n·]*?)\s*·\s*\[SOURCE\]\s*([^\n·]*?)\s*·\s*\[FRESHNESS\]\s*([^\n]*)/
  );
  if (footer) {
    period = footer[1].trim() || null;
    source = footer[2].trim() || null;
    freshness = footer[3].trim() || null;
    body = body.slice(0, footer.index);
  }

  const pattern = /\[(CALCULATED FACT|DETECTED PATTERN|AUTOMATED INTERPRETATION|SUGGESTED ACTION|UNVERIFIED HYPOTHESIS)\]\s*/g;
  const matches = [...body.matchAll(pattern)];
  const sections: ZeliAnswerSection[] = [];
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const text = body.slice(start, end).trim();
    const tag = LEGACY_TAGS.find(([label]) => label === match[1]);
    if (tag && text) {
      sections.push({ kind: tag[1], label: SECTION_LABELS[tag[1]], text });
    }
  });

  return sections.length
    ? { sections, meta: { period, source, freshness, limitations } }
    : null;
}
