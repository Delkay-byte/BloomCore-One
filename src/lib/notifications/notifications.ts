/**
 * Durable in-app notifications.
 *
 * `kind` keeps verified system events separate from AI-generated insights and
 * `dedupeKey` guarantees a repeated condition does not create a second entry.
 * Notifications are tenant-scoped; platform notifications use audience
 * "platform" and are only rendered inside the platform console.
 */

import { db } from "@/lib/db";

export type NotificationAudience = "tenant" | "platform";
export type NotificationKind = "system" | "insight";
export type NotificationSeverity = "critical" | "attention" | "info";

export interface NotificationInput {
  tenantId?: string | null;
  audience?: NotificationAudience;
  kind?: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  href?: string | null;
  dedupeKey: string;
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Create once per dedupeKey; a repeat returns null and changes nothing. */
export async function createNotification(input: NotificationInput): Promise<string | null> {
  try {
    const created = await db.tenantNotification.create({
      data: {
        tenantId: input.tenantId ?? null,
        audience: input.audience ?? "tenant",
        kind: input.kind ?? "system",
        severity: input.severity ?? "info",
        title: input.title.slice(0, 140),
        body: input.body.slice(0, 600),
        href: input.href ?? null,
        dedupeKey: input.dedupeKey.slice(0, 200),
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (uniqueViolation(error)) return null;
    throw error;
  }
}

export async function listNotifications(options: {
  tenantId?: string | null;
  audience?: NotificationAudience;
  limit?: number;
  unreadOnly?: boolean;
  includeResolved?: boolean;
}) {
  const where: Record<string, unknown> = { audience: options.audience ?? "tenant" };
  if (options.tenantId) where.tenantId = options.tenantId;
  if (options.unreadOnly) where.readAt = null;
  if (!options.includeResolved) where.resolvedAt = null;
  return db.tenantNotification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options.limit ?? 20, 1), 100),
  });
}

export async function markNotificationRead(input: {
  id: string;
  tenantId?: string | null;
  audience?: NotificationAudience;
}): Promise<boolean> {
  const updated = await db.tenantNotification.updateMany({
    where: {
      id: input.id,
      audience: input.audience ?? "tenant",
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return updated.count > 0;
}

export async function resolveNotification(input: {
  id: string;
  tenantId?: string | null;
  audience?: NotificationAudience;
}): Promise<boolean> {
  const updated = await db.tenantNotification.updateMany({
    where: {
      id: input.id,
      audience: input.audience ?? "tenant",
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      resolvedAt: null,
    },
    data: { resolvedAt: new Date(), readAt: new Date() },
  });
  return updated.count > 0;
}

export async function markAllNotificationsRead(input: {
  tenantId?: string | null;
  audience?: NotificationAudience;
}): Promise<number> {
  const updated = await db.tenantNotification.updateMany({
    where: {
      audience: input.audience ?? "tenant",
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      readAt: null,
    },
    data: { readAt: new Date() },
  });
  return updated.count;
}

export async function unreadNotificationCount(input: {
  tenantId?: string | null;
  audience?: NotificationAudience;
}): Promise<number> {
  return db.tenantNotification.count({
    where: {
      audience: input.audience ?? "tenant",
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      readAt: null,
      resolvedAt: null,
    },
  });
}
