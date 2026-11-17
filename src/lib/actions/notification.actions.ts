"use server";

import { revalidatePath } from "next/cache";
import { requireTenantAdmin } from "@/lib/tenant";
import { requirePlatformPage } from "@/lib/platform-auth";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotification,
  unreadNotificationCount,
  type NotificationAudience,
} from "@/lib/notifications/notifications";

export interface NotificationRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

async function scopeFor(audience: NotificationAudience): Promise<{ tenantId: string | null; audience: NotificationAudience }> {
  if (audience === "platform") {
    await requirePlatformPage();
    return { tenantId: null, audience };
  }
  const ctx = await requireTenantAdmin();
  return { tenantId: ctx.tenantId, audience };
}

export async function getNotifications(audience: NotificationAudience): Promise<{
  items: NotificationRow[];
  unread: number;
}> {
  const scope = await scopeFor(audience);
  const [items, unread] = await Promise.all([
    listNotifications({ ...scope, limit: 8, includeResolved: false }),
    unreadNotificationCount(scope),
  ]);
  return {
    unread,
    items: items.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function markNotificationReadAction(
  audience: NotificationAudience,
  id: string
): Promise<{ ok: boolean }> {
  const scope = await scopeFor(audience);
  const ok = await markNotificationRead({ ...scope, id });
  revalidatePath(audience === "platform" ? "/platform/dashboard" : "/admin/dashboard");
  return { ok };
}

export async function resolveNotificationAction(
  audience: NotificationAudience,
  id: string
): Promise<{ ok: boolean }> {
  const scope = await scopeFor(audience);
  const ok = await resolveNotification({ ...scope, id });
  revalidatePath(audience === "platform" ? "/platform/dashboard" : "/admin/dashboard");
  return { ok };
}

export async function markAllNotificationsReadAction(
  audience: NotificationAudience
): Promise<{ ok: boolean }> {
  const scope = await scopeFor(audience);
  await markAllNotificationsRead(scope);
  revalidatePath(audience === "platform" ? "/platform/dashboard" : "/admin/dashboard");
  return { ok: true };
}
