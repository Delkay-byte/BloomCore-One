"use client";

import {
  normaliseAnswerMeta,
  normaliseSections,
  parseLegacyAnswer,
  type ZeliAnswerSection,
} from "@/lib/zeli/response-format";

function groupSections(sections: ZeliAnswerSection[]) {
  const groups: Array<{ kind: ZeliAnswerSection["kind"]; label: string; rows: string[] }> = [];
  for (const section of sections) {
    const last = groups[groups.length - 1];
    if (last?.kind === section.kind) last.rows.push(section.text);
    else groups.push({ kind: section.kind, label: section.label, rows: [section.text] });
  }
  return groups;
}

export default function ZeliAnswerView({
  content,
  sections,
  answerMeta,
}: {
  content: string;
  sections?: unknown;
  answerMeta?: unknown;
}) {
  const structured = normaliseSections(sections);
  const legacy = structured.length ? null : parseLegacyAnswer(content);
  const rows = structured.length ? structured : legacy?.sections ?? [];
  const meta = normaliseAnswerMeta(answerMeta) ?? legacy?.meta ?? null;

  if (!rows.length) {
    return <p className="whitespace-pre-wrap break-words">{content}</p>;
  }

  return (
    <div className="space-y-3">
      {groupSections(rows).map((group, index) => (
        <section key={`${group.kind}-${index}`} aria-label={group.label}>
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {group.label}
          </h3>
          {group.kind === "calculated_fact" ? (
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {group.rows.map((text, rowIndex) => (
                <li key={rowIndex} className="break-words">
                  {text}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-1 space-y-1">
              {group.rows.map((text, rowIndex) => (
                <p key={rowIndex} className="whitespace-pre-wrap break-words">
                  {text}
                </p>
              ))}
            </div>
          )}
        </section>
      ))}

      {meta && (meta.period || meta.source || meta.freshness || meta.limitations.length > 0) && (
        <div className="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-xs text-slate-600">
          <dl className="grid gap-1 sm:grid-cols-3">
            {meta.period && (
              <div>
                <dt className="font-medium text-slate-700">Period</dt>
                <dd>{meta.period}</dd>
              </div>
            )}
            {meta.source && (
              <div>
                <dt className="font-medium text-slate-700">Source</dt>
                <dd>{meta.source}</dd>
              </div>
            )}
            {meta.freshness && (
              <div>
                <dt className="font-medium text-slate-700">Freshness</dt>
                <dd>{meta.freshness}</dd>
              </div>
            )}
          </dl>
          {meta.limitations.length > 0 && (
            <details className="mt-2 border-t border-slate-200 pt-2">
              <summary className="cursor-pointer font-medium text-slate-700">
                Limitations
              </summary>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {meta.limitations.map((limitation, index) => (
                  <li key={index}>{limitation}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
