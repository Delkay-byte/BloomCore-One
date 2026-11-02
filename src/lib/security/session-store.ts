import { db } from "../db";

/**
 * Server-side session registry.
 *
 * The JWT remains the transport, but a token is only honoured while its `jti`
 * row is present, unexpired and unrevoked. This is what makes logout, password
 * change and administrative revocation effective server-side instead of merely
 * deleting a browser cookie.
 *
 * Legacy tokens issued before this control have no `jti`; they are accepted
 * until their short absolute expiry (8 hours) and are replaced at next login.
 */

export interface SessionRecordInput {
  id: string;
  subjectType: "user" | "customer" | "platform";
  subjectId: string;
  tenantId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  expiresAt: Date;
}

export async function createSessionRecord(input: SessionRecordInput): Promise<void> {
  try {
    await db.sessionRecord.create({
      data: {
        id: input.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        tenantId: input.tenantId ?? null,
        ipHash: input.ipHash ?? null,
        userAgentHash: input.userAgentHash ?? null,
        expiresAt: input.expiresAt,
      },
    });
  } catch (error) {
    // A failure to register means the token must not be trusted. Re-throw so
    // the login aborts rather than issuing an unrevocable session.
    throw error;
  }
}

export async function isSessionRecordActive(
  jti: string | undefined | null,
  now: number = Date.now()
): Promise<boolean> {
  // Legacy token (issued before the registry existed): allow until expiry.
  if (!jti) return true;
  try {
    const record = await db.sessionRecord.findUnique({ where: { id: jti } });
    if (!record) return false;
    if (record.revokedAt) return false;
    if (record.expiresAt.getTime() <= now) return false;
    return true;
  } catch {
    return false;
  }
}

export async function touchSessionRecord(
  jti: string | undefined | null,
  now: number = Date.now()
): Promise<void> {
  if (!jti) return;
  try {
    await db.sessionRecord.updateMany({
      where: { id: jti, revokedAt: null },
      data: { lastSeenAt: new Date(now) },
    });
  } catch {
    // Best effort: activity tracking must never block a request.
  }
}

export async function revokeSession(
  jti: string | undefined | null,
  reason: string
): Promise<void> {
  if (!jti) return;
  try {
    await db.sessionRecord.updateMany({
      where: { id: jti, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  } catch {
    // Logout still clears the cookie even if the registry is unavailable.
  }
}

export async function revokeAllSubjectSessions(
  subjectType: "user" | "customer" | "platform",
  subjectId: string,
  reason: string
): Promise<void> {
  try {
    await db.sessionRecord.updateMany({
      where: { subjectType, subjectId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  } catch {
    // tokenVersion is the backstop if the registry write fails.
  }
}

/** Remove rows that expired long ago. */
export async function pruneSessionRecords(now: number = Date.now()): Promise<void> {
  try {
    await db.sessionRecord.deleteMany({
      where: { expiresAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } },
    });
  } catch {
    // best effort
  }
}
