import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { db } from "@/lib/db";
import {
  presentAuditEntry,
  type AuditEntityContext,
} from "@/lib/audit-presentation";

interface AuditRow {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: string | null;
  ipAddress: string | null;
  createdAt: Date;
}

function dateLabel(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function money(value: unknown): string | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `GH₵${amount.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeType(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseDetails(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the human-readable context for audit entities in one batch.
 *
 * Every lookup is tenant-scoped. A reference that cannot be resolved leaves the
 * entity label in place; the table never falls back to a truncated database id.
 */
async function buildAuditContext(
  logs: AuditRow[],
  tenantId: string
): Promise<Map<string, AuditEntityContext>> {
  const byType = new Map<string, Set<string>>();
  const deviceRefs = new Set<string>();
  for (const log of logs) {
    if (!log.entityId) continue;
    const key = normalizeType(log.entityType);
    if (!byType.has(key)) byType.set(key, new Set());
    byType.get(key)!.add(log.entityId);
    if (key === "device" || key === "deviceenrollment") {
      const details = parseDetails(log.details);
      if (typeof details.deviceId === "string") deviceRefs.add(details.deviceId);
    }
  }

  const ids = (key: string): string[] => Array.from(byType.get(key) ?? []);
  const context = new Map<string, AuditEntityContext>();
  const put = (id: string, value: AuditEntityContext) => context.set(id, value);

  const safe = async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch {
      return null;
    }
  };

  const [
    dailyAccounts,
    users,
    customers,
    contributions,
    withdrawals,
    expenses,
    locations,
    devices,
    remittances,
    offlineRows,
  ] = await Promise.all([
    safe(() =>
      db.dailyAccount.findMany({
        where: { tenantId, id: { in: ids("dailyaccount") } },
        select: {
          id: true,
          businessDate: true,
          location: { select: { name: true } },
          worker: { select: { fullName: true } },
        },
      })
    ),
    safe(() =>
      db.user.findMany({
        where: { tenantId, id: { in: ids("user") } },
        select: { id: true, fullName: true, role: true },
      })
    ),
    safe(() =>
      db.customer.findMany({
        where: { tenantId, id: { in: ids("customer") } },
        select: { id: true, fullName: true, customerId: true },
      })
    ),
    safe(() =>
      db.contribution.findMany({
        where: { tenantId, id: { in: ids("contribution") } },
        select: {
          id: true,
          amount: true,
          collectionDate: true,
          account: {
            select: { customer: { select: { fullName: true, customerId: true } } },
          },
        },
      })
    ),
    safe(() =>
      db.withdrawal.findMany({
        where: { tenantId, id: { in: ids("withdrawal") } },
        select: {
          id: true,
          netAmount: true,
          createdAt: true,
          account: {
            select: { customer: { select: { fullName: true, customerId: true } } },
          },
        },
      })
    ),
    safe(() =>
      db.expense.findMany({
        where: { tenantId, id: { in: ids("expense") } },
        select: { id: true, description: true, amount: true },
      })
    ),
    safe(() =>
      db.location.findMany({
        where: { tenantId, id: { in: ids("location") } },
        select: { id: true, name: true, code: true },
      })
    ),
    safe(() =>
      db.deviceEnrollment.findMany({
        where: {
          tenantId,
          OR: [
            { id: { in: ids("device") } },
            { deviceId: { in: Array.from(deviceRefs) } },
          ],
        },
        select: {
          id: true,
          deviceId: true,
          deviceName: true,
          module: true,
          user: { select: { fullName: true } },
        },
      })
    ),
    safe(() =>
      db.collectorRemittance.findMany({
        where: { tenantId, id: { in: ids("collectorremittance") } },
        select: {
          id: true,
          remittedAmount: true,
          createdAt: true,
          collector: { select: { user: { select: { fullName: true } } } },
        },
      })
    ),
    safe(() =>
      db.offlineTransaction.findMany({
        where: { tenantId, id: { in: ids("offlinetransaction") } },
        select: { id: true, type: true, localTimestamp: true },
      })
    ),
  ]);

  for (const row of dailyAccounts ?? []) {
    const date = dateLabel(row.businessDate);
    put(row.id, {
      label: "Daily Closing",
      reference: date ? `Daily Closing — ${date}` : "Daily Closing",
      secondary: [row.location?.name, row.worker?.fullName].filter(Boolean).join(" · "),
    });
  }
  for (const row of users ?? []) {
    put(row.id, {
      label: "User",
      reference: row.fullName,
      secondary: row.role ? row.role.replace(/\b\w/g, (c) => c.toUpperCase()) : null,
    });
  }
  for (const row of customers ?? []) {
    put(row.id, {
      label: "Customer",
      reference: row.fullName,
      secondary: row.customerId,
    });
  }
  for (const row of contributions ?? []) {
    const customer = row.account?.customer;
    put(row.id, {
      label: "Contribution",
      reference: customer?.fullName
        ? `Contribution — ${customer.fullName}`
        : "Contribution",
      secondary: [money(row.amount), dateLabel(row.collectionDate)]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const row of withdrawals ?? []) {
    const customer = row.account?.customer;
    put(row.id, {
      label: "Withdrawal",
      reference: customer?.fullName
        ? `Withdrawal — ${customer.fullName}`
        : "Withdrawal",
      secondary: [money(row.netAmount), dateLabel(row.createdAt)]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const row of expenses ?? []) {
    put(row.id, {
      label: "Expense",
      reference: row.description,
      secondary: money(row.amount),
    });
  }
  for (const row of locations ?? []) {
    put(row.id, {
      label: "Location",
      reference: row.name,
      secondary: row.code,
    });
  }
  for (const row of devices ?? []) {
    put(row.id, {
      label: "Device",
      reference: row.deviceName || "Registered device",
      secondary: [row.user?.fullName, row.module ? row.module.toUpperCase() : null]
        .filter(Boolean)
        .join(" · "),
    });
    // A device audit row may store the device identifier in details instead of
    // entityId. Resolve that form too without treating it as the primary label.
    put(row.deviceId, {
      label: "Device",
      reference: row.deviceName || "Registered device",
      secondary: [row.user?.fullName, row.module ? row.module.toUpperCase() : null]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const row of remittances ?? []) {
    put(row.id, {
      label: "Money Handed In",
      reference: row.collector?.user?.fullName
        ? `Money Handed In — ${row.collector.user.fullName}`
        : "Money Handed In",
      secondary: [money(row.remittedAmount), dateLabel(row.createdAt)]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const row of offlineRows ?? []) {
    put(row.id, {
      label: "Offline Record",
      reference:
        row.type === "contribution" ? "Offline collection" : "Offline daily account draft",
      secondary: dateLabel(row.localTimestamp),
    });
  }

  return context;
}

/**
 * GET /api/audit
 *
 * Tenant-scoped audit history for the authenticated business administrator.
 *
 * Isolation: results are filtered by the tenant resolved from the server
 * session. A tenant administrator can never read another business's audit
 * trail, and the platform audit trail (PlatformAuditLog) is a separate table
 * that is never exposed here.
 *
 * The stored audit row is returned unchanged. A presentation object is added
 * for display; it never rewrites history, attribution or timestamps.
 */
export async function GET(request: NextRequest) {
  const ctx = await getApiTenantContext("admin");
  if (!ctx) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (ctx.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") || "30", 10) || 30)
  );
  const skip = (page - 1) * limit;

  const where = { tenantId: ctx.tenantId };

  const [logs, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.auditLog.count({ where }),
  ]);

  const context = await buildAuditContext(logs as AuditRow[], ctx.tenantId);

  const actorIds = Array.from(new Set(logs.map((log) => log.userId)));
  let actorNames = new Map<string, string>();
  try {
    const actors = await db.user.findMany({
      where: { tenantId: ctx.tenantId, id: { in: actorIds } },
      select: { id: true, fullName: true },
    });
    actorNames = new Map(actors.map((actor) => [actor.id, actor.fullName]));
  } catch {
    actorNames = new Map();
  }

  const presented = logs.map((log) => ({
    ...log,
    presentation: presentAuditEntry({
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      details: log.details,
      actorName: actorNames.get(log.userId) ?? null,
      entity: context.get(log.entityId ?? "") ?? null,
    }),
  }));

  return NextResponse.json({ logs: presented, total, page, limit });
}
