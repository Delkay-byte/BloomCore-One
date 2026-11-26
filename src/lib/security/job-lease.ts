import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Cross-process execution lease for singleton jobs.
 *
 * The claim and every ownership check are single atomic UPDATE statements, so
 * they work identically on PostgreSQL and SQLite and across application
 * instances that share the database. No in-process flag is authoritative.
 *
 * The fencing token increments on each takeover. Every destructive step calls
 * `assertJobLease` before writing; a stale owner whose lease expired or was
 * taken over fails that check and stops before its next mutation. The same
 * atomic check renews the lease, so a long sweep cannot lose its own lease
 * while it is actively making progress.
 */

export const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
export const RETENTION_LEASE_KEY = "risk_retention_sweep";

export interface JobLease {
  id: string;
  key: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: Date;
}

export class LeaseLostError extends Error {
  constructor(key: string) {
    super(`Execution lease lost for ${key}`);
    this.name = "LeaseLostError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2002";
}

/**
 * Atomically claim the lease, or return null when another live execution owns
 * it. An expired or explicitly released lease can be taken over safely.
 */
export async function acquireJobLease(
  key: string,
  durationMs = DEFAULT_LEASE_DURATION_MS
): Promise<JobLease | null> {
  const now = new Date();
  const ownerId = randomUUID();
  const expiresAt = new Date(now.getTime() + durationMs);

  try {
    const created = await db.systemJobLease.create({
      data: {
        key,
        ownerId,
        fencingToken: 0,
        status: "running",
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
      },
      select: { id: true, key: true, ownerId: true, fencingToken: true, expiresAt: true },
    });
    return created;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  // The row already exists. Only one concurrent caller can win this UPDATE.
  const claimed = await db.systemJobLease.updateMany({
    where: {
      key,
      OR: [{ status: "released" }, { expiresAt: { lte: now } }],
    },
    data: {
      ownerId,
      status: "running",
      fencingToken: { increment: 1 },
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      releasedAt: null,
      lastOutcome: null,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.systemJobLease.findUnique({
    where: { key },
    select: { id: true, key: true, ownerId: true, fencingToken: true, expiresAt: true },
  });
  if (!row || row.ownerId !== ownerId) return null;
  return row;
}

/**
 * Fence and renew in one statement. Throws when this execution no longer owns
 * a live lease. Call before every destructive step, not just at the start.
 */
export async function assertJobLease(
  lease: JobLease,
  durationMs = DEFAULT_LEASE_DURATION_MS
): Promise<void> {
  const now = new Date();
  const result = await db.systemJobLease.updateMany({
    where: {
      id: lease.id,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      status: "running",
      expiresAt: { gt: now },
    },
    data: {
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + durationMs),
    },
  });
  if (result.count !== 1) throw new LeaseLostError(lease.key);
}

/** Release only the lease owned by this execution. */
export async function releaseJobLease(
  lease: JobLease,
  outcome: "success" | "failed" | "lost" | "none"
): Promise<void> {
  await db.systemJobLease.updateMany({
    where: {
      id: lease.id,
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      status: "running",
    },
    data: {
      status: "released",
      releasedAt: new Date(),
      lastOutcome: outcome,
    },
  });
}
