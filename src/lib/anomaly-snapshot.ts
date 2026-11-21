/**
 * The digest of exactly what a scan saw.
 *
 * Kept apart from the rest of the investigation module because it needs
 * `node:crypto`, and a browser component that only wants labels must not pull a
 * Node builtin into the client bundle. Same rule as the evidence and provider
 * statement label splits.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/anomaly-investigation";

/**
 * A hash of exactly what was seen.
 *
 * Keys are sorted so the same evidence always produces the same digest, which is
 * what makes "the evidence changed" a reliable comparison rather than a guess.
 */
export function snapshotHash(
  entityType: string,
  entityId: string,
  evidence: Record<string, unknown> | null
): string {
  return createHash("sha256")
    .update(`${entityType}:${entityId}:${canonicalJson(evidence)}`)
    .digest("hex");
}
