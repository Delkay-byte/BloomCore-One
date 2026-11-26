/**
 * Evidence limits and allowlists.
 *
 * Kept free of Node built-ins so a browser component can show the same rules the
 * server enforces. The storage code lives in `evidence.ts`, which imports this
 * module; importing the other direction would pull `fs` into the client bundle.
 */

export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const EVIDENCE_RETENTION_YEARS = 7;

export const EVIDENCE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

export const EVIDENCE_SUBJECT_TYPES = [
  "customerDispute",
  "operationalAnomaly",
  "offlineActionRequest",
] as const;
export type EvidenceSubjectType = (typeof EVIDENCE_SUBJECT_TYPES)[number];

export function isEvidenceContentType(value: string): value is EvidenceContentType {
  return (EVIDENCE_CONTENT_TYPES as readonly string[]).includes(value);
}

export function isEvidenceSubjectType(value: string): value is EvidenceSubjectType {
  return (EVIDENCE_SUBJECT_TYPES as readonly string[]).includes(value);
}
