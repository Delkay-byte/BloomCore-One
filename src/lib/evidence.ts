/**
 * Evidence files.
 *
 * A dispute or an anomaly can point at a file: a receipt photo, a bank SMS, a
 * provider statement extract. The file itself is stored outside the database in
 * a private directory, and this module owns the rules:
 *
 * - only a small allowlist of image/document types, with a size ceiling;
 * - the SHA-256 of the exact bytes is recorded, so tampering is detectable;
 * - a retention date is set on upload;
 * - reading a file is a separate, authorised step, never a public URL.
 *
 * Large-file or third-party storage is a deployment decision; the directory is
 * configurable and defaults to a private folder next to the application.
 */

import { createHash, randomBytes } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_RETENTION_YEARS,
  isEvidenceContentType,
} from "@/lib/evidence-constants";

export {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_RETENTION_YEARS,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_SUBJECT_TYPES,
  isEvidenceContentType,
  isEvidenceSubjectType,
  type EvidenceContentType,
  type EvidenceSubjectType,
} from "@/lib/evidence-constants";

/**
 * Where the bytes live.
 *
 * `EVIDENCE_STORAGE_DIR` must point at a private location outside the web root.
 * The default is a dot-directory in the working tree, which is ignored by Git
 * and is not served by the application.
 */
export function evidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.EVIDENCE_STORAGE_DIR ?? "").trim();
  return configured || path.join(process.cwd(), ".data", "evidence");
}

export function retentionDeadline(
  from: Date,
  years: number = EVIDENCE_RETENTION_YEARS
): Date {
  const deadline = new Date(from);
  deadline.setUTCFullYear(deadline.getUTCFullYear() + years);
  return deadline;
}

/** A sanitised display name: no path separators, no control characters. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "evidence";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\w.\- ()]/g, "_")
    .slice(0, 120)
    .trim();
  return cleaned || "evidence";
}

export interface EvidenceValidation {
  ok: boolean;
  error?: string;
}

export function validateEvidence(input: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): EvidenceValidation {
  if (!input.fileName.trim()) return { ok: false, error: "Choose a file to attach." };
  if (!isEvidenceContentType(input.contentType)) {
    return {
      ok: false,
      error: "Attach a JPEG, PNG, WebP image or a PDF.",
    };
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (input.sizeBytes > EVIDENCE_MAX_BYTES) {
    return {
      ok: false,
      error: `That file is larger than ${Math.round(EVIDENCE_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }
  return { ok: true };
}

export function hashEvidence(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface StoredEvidence {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Write the bytes and return the storage key and digest.
 *
 * The key is random and namespaced by tenant, so one business's files never sit
 * beside another's and a guessed key cannot reach a file.
 */
export async function storeEvidenceBytes(input: {
  tenantId: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<StoredEvidence> {
  const sha256 = hashEvidence(input.bytes);
  const key = path.posix.join(
    input.tenantId.replace(/[^\w-]/g, "_"),
    `${randomBytes(12).toString("hex")}.${extensionFor(input.contentType)}`
  );
  const target = path.join(evidenceRoot(), key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, input.bytes, { mode: 0o600 });
  return { storageKey: key, sha256, sizeBytes: input.bytes.byteLength };
}

/**
 * A storage key is exactly one tenant directory and one random file name.
 *
 * Anything else — a traversal, an absolute path, a hand-written name — is
 * refused before the filesystem is touched.
 */
const STORAGE_KEY_PATTERN = /^[\w-]{1,64}\/[0-9a-f]{24}\.(jpg|png|webp|pdf)$/;

export function isStorageKey(value: string): boolean {
  return STORAGE_KEY_PATTERN.test(value);
}

function resolveStored(key: string): string | null {
  if (!isStorageKey(key)) return null;
  const root = path.resolve(evidenceRoot());
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep)) return null;
  return target;
}

/** Read a stored file back. The caller must already have authorised access. */
export async function readEvidenceBytes(storageKey: string): Promise<Buffer | null> {
  const target = resolveStored(storageKey);
  if (!target) return null;
  try {
    return await readFile(target);
  } catch {
    return null;
  }
}

export async function removeEvidenceBytes(storageKey: string): Promise<void> {
  const target = resolveStored(storageKey);
  if (!target) return;
  await rm(target, { force: true });
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      return "jpg";
  }
}

/** Retention has passed and the record may be disposed of. */
export function retentionElapsed(retentionUntil: Date, now = new Date()): boolean {
  return retentionUntil.getTime() <= now.getTime();
}
