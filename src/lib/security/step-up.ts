/**
 * SEC-04 — Server-side step-up authorization.
 *
 * A step-up grant proves that the authenticated subject re-entered their
 * password (and completed MFA when their account policy requires it) for one
 * specific sensitive operation. It is:
 *
 * - bound to the subject, the server-side session (`jti`) and one purpose;
 * - bound to an optional target and a canonical context hash (for example the
 *   account and amount of a withdrawal);
 * - short-lived (five minutes), single-use and stored only as a token hash;
 * - consumed inside the protected operation's transaction.
 *
 * Nothing here trusts a browser-supplied boolean. The action itself must call
 * `claimStepUpGrant` with the session it already authenticated.
 */

import { createHash, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const STEP_UP_TTL_MS = 5 * 60 * 1000;

export type StepUpSubjectType = "user" | "platform";

export const STEP_UP_PURPOSES = [
  "susu.withdrawal",
  // Phase 4: staged withdrawal approval and payment each need their own grant.
  "withdrawal.approve",
  "withdrawal.pay",
  "susu.remittance.reverse",
  "susu.contribution.reverse",
  "susu.withdrawal.reverse",
  "finance.daily_account.correct",
  "finance.momo_transaction.reverse",
  "finance.branch_transfer.approve",
  "finance.branch_transfer.resolve",
  "finance.shift_handover.resolve",
  // A2: a shared-device actor proves their own identity before a sensitive count
  // is submitted. Bound to the shift or daily account being submitted.
  "finance.shift_count.submit",
  "finance.daily_close.submit",
  "staff.password_reset",
  "worker.password_reset",
  "collector.password_reset",
  // Phase 2: collector lifecycle changes (activate / deactivate / suspend /
  // reactivate). Bound to the collector being changed and the acting admin.
  "collector.lifecycle",
  "tenant.admin_access_reset",
  "capability.change",
  // Phase 8: staff offboarding/reactivation and privileged staff assignment
  // changes. Bound to the target staff user so a grant cannot be replayed for
  // a different person.
  "staff.lifecycle",
  "staff.assignment",
  // Phase 8: bulk download of an administrative dataset (staff directory).
  // Bound to the dataset name so a grant for one export cannot authorise another.
  "admin.export",
  "platform.mfa_recovery",
] as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

const PURPOSE_SET = new Set<string>(STEP_UP_PURPOSES);

const DENIED =
  "Reauthentication expired or does not match this operation. Confirm your password again.";

export function hashStepUpToken(rawToken: string): string {
  return createHash("sha256").update(`step-up:${rawToken}`).digest("hex");
}

/**
 * Stable binding for the session that requested a grant.
 *
 * Registered sessions bind to their registry id. Legacy jti-less tokens (only
 * accepted until their short expiry) bind to the subject plus issue time so a
 * grant still cannot be replayed from a different sign-in.
 */
export function stepUpSessionBinding(
  session: { jti?: string | null; iat?: number } | null | undefined,
  subjectId: string
): string {
  return session?.jti ?? `legacy:${subjectId}:${session?.iat ?? 0}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = stableValue(record[key]);
        return out;
      }, {});
  }
  return value;
}

/**
 * Canonical hash of everything the grant authorizes. Callers must pass the
 * same values at creation and consumption. Money is supplied as an integer
 * minor unit string so 10, 10.0 and "10.00" cannot disagree accidentally.
 */
export function stepUpContextHash(input: {
  purpose: StepUpPurpose;
  targetType?: string | null;
  targetId?: string | null;
  context?: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          purpose: input.purpose,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          context: input.context ?? {},
        })
      )
    )
    .digest("hex");
}

export interface CreateStepUpGrantInput {
  subjectType: StepUpSubjectType;
  subjectId: string;
  sessionId: string | undefined | null;
  purpose: StepUpPurpose;
  targetType?: string | null;
  targetId?: string | null;
  context?: Record<string, unknown>;
}

/** Create a grant after the caller has proven the password and MFA state. */
export async function createStepUpGrant(
  input: CreateStepUpGrantInput
): Promise<{ token: string; expiresAt: Date }> {
  if (!PURPOSE_SET.has(input.purpose)) {
    throw new Error("Unsupported step-up purpose");
  }
  const sessionId = input.sessionId;
  if (!sessionId) {
    throw new Error("A registered session is required for step-up authorization");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + STEP_UP_TTL_MS);

  await db.$transaction(async (tx) => {
    // Supersede any unused grant for the same session and purpose. This keeps
    // one live confirmation per action instead of an accumulating set.
    await tx.stepUpGrant.updateMany({
      where: {
        sessionId,
        purpose: input.purpose,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    await tx.stepUpGrant.create({
      data: {
        tokenHash: hashStepUpToken(token),
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        sessionId,
        purpose: input.purpose,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        contextHash: stepUpContextHash(input),
        expiresAt,
      },
    });
  });

  return { token, expiresAt };
}

export interface ClaimStepUpGrantInput {
  token: string | undefined | null;
  subjectType: StepUpSubjectType;
  subjectId: string;
  sessionId: string | undefined | null;
  purpose: StepUpPurpose;
  targetType?: string | null;
  targetId?: string | null;
  context?: Record<string, unknown>;
}

export type StepUpResult = { ok: true } | { ok: false; error: string };

/** Thrown inside a transaction so consumption and the write roll back together. */
export class StepUpDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpDeniedError";
  }
}

/**
 * Atomically consume a grant inside the caller's transaction.
 *
 * `updateMany` with `consumedAt: null` is the concurrency gate: exactly one
 * request can move the row from unused to consumed, even across server
 * instances. Call this before the protected write so a failed operation rolls
 * the consumption back with it.
 */
export async function claimStepUpGrant(
  tx: Prisma.TransactionClient,
  input: ClaimStepUpGrantInput
): Promise<StepUpResult> {
  if (!input.token || input.token.length > 512) {
    return { ok: false, error: DENIED };
  }
  if (!input.sessionId) return { ok: false, error: DENIED };
  if (!PURPOSE_SET.has(input.purpose)) return { ok: false, error: DENIED };

  const tokenHash = hashStepUpToken(input.token);
  const row = await tx.stepUpGrant.findUnique({ where: { tokenHash } });
  if (!row) return { ok: false, error: DENIED };

  const now = new Date();
  if (row.consumedAt || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, error: DENIED };
  }
  if (
    row.subjectType !== input.subjectType ||
    row.subjectId !== input.subjectId ||
    row.sessionId !== input.sessionId ||
    row.purpose !== input.purpose ||
    (row.targetType ?? null) !== (input.targetType ?? null) ||
    (row.targetId ?? null) !== (input.targetId ?? null) ||
    row.contextHash !== stepUpContextHash(input)
  ) {
    return { ok: false, error: DENIED };
  }

  const claimed = await tx.stepUpGrant.updateMany({
    where: {
      id: row.id,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return { ok: false, error: DENIED };
  return { ok: true };
}

/** Revoke every outstanding grant for a session (logout, password change). */
export async function revokeSessionStepUpGrants(
  sessionId: string | undefined | null
): Promise<void> {
  if (!sessionId) return;
  try {
    await db.stepUpGrant.updateMany({
      where: { sessionId, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch {
    // Best effort: expiry still bounds an unused grant.
  }
}

/** Remove grants that expired long ago. */
export async function pruneStepUpGrants(now: number = Date.now()): Promise<void> {
  try {
    await db.stepUpGrant.deleteMany({
      where: { expiresAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    });
  } catch {
    // best effort
  }
}
