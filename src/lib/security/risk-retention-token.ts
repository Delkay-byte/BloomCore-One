import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Non-mutating verification of the internal retention token.
 *
 * Kept outside the `"use server"` governance module: Next.js requires every
 * export of a server-action module to be an async function. Moving this pure
 * helper does not change its behaviour or the secret it checks.
 */
export function verifyRiskRetentionToken(input: unknown): boolean {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(input);
  const configured = process.env.RISK_RETENTION_TOKEN?.trim();
  if (!parsed.success || !configured) return false;
  const provided = Buffer.from(parsed.data.token);
  const expected = Buffer.from(configured);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
