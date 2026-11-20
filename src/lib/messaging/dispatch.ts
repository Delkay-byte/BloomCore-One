/**
 * Scheduled delivery for customer messages.
 *
 * The outbox has always been durable; what was missing is something that runs
 * when no receipt happens to be created. This module is that something: one
 * bounded pass over every business's due rows, oldest first, with a summary an
 * operator can read. It is invoked by `/api/internal/messaging/dispatch`, which
 * requires a shared secret, and the same function can be called from a job
 * runner without changing the delivery rules.
 *
 * A pass never claims a row it cannot deliver: `deliverPendingCustomerMessages`
 * claims with a status/attempt guard, so two concurrent passes cannot send the
 * same message twice.
 */

import { db } from "@/lib/db";
import { deliverPendingCustomerMessages } from "@/lib/messaging/outbox";

export interface MessagingDispatchSummary {
  ranAt: string;
  /** Businesses with at least one due row in this pass. */
  tenants: number;
  /** Rows attempted in this pass. */
  attempted: number;
  /** Rows a provider accepted for delivery in this pass. */
  accepted: number;
  /**
   * Rows a provider could not deliver but did not refuse, because no approved
   * provider is configured. Counted separately: simulated is never delivery.
   */
  simulated: number;
  /** Rows still waiting, including those whose backoff has not elapsed. */
  pending: number;
  /** Rows that will never be sent until a person changes something. */
  blocked: number;
}

export const DISPATCH_BATCH_LIMIT = 20;
export const DISPATCH_MAX_TENANTS_PER_PASS = 25;

/**
 * Run one delivery pass.
 *
 * `limit` is per business and is clamped by the outbox itself, so an operator
 * cannot turn one call into an unbounded send.
 */
export async function runMessagingDispatch(
  limit = DISPATCH_BATCH_LIMIT
): Promise<MessagingDispatchSummary> {
  const ranAt = new Date();
  const due = await db.customerMessageOutbox.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: ranAt },
      attempts: { lt: 5 },
    },
    select: { tenantId: true },
    distinct: ["tenantId"],
    take: DISPATCH_MAX_TENANTS_PER_PASS,
  });

  const attempted = await db.customerMessageOutbox.count({
    where: { status: "pending", nextAttemptAt: { lte: ranAt }, attempts: { lt: 5 } },
  });

  let accepted = 0;
  let simulated = 0;
  for (const tenant of due) {
    // A tenant with no id cannot be resolved to a business, so its rows are left
    // for a person rather than sent with the wrong settings.
    if (!tenant.tenantId) continue;
    const sent = await db.customerMessageOutbox
      .findMany({
        where: {
          tenantId: tenant.tenantId,
          status: "pending",
          nextAttemptAt: { lte: ranAt },
          attempts: { lt: 5 },
        },
        select: { id: true },
        take: Math.min(Math.max(limit, 1), DISPATCH_BATCH_LIMIT),
      })
      .then((rows) => rows.length);
    if (sent === 0) continue;
    accepted += await deliverPendingCustomerMessages(sent);
    simulated += await db.customerMessageOutbox.count({
      where: { tenantId: tenant.tenantId, status: "simulated" },
    });
  }

  const [pending, blocked] = await Promise.all([
    db.customerMessageOutbox.count({ where: { status: { in: ["pending", "sending"] } } }),
    db.customerMessageOutbox.count({ where: { status: "rejected" } }),
  ]);

  return {
    ranAt: ranAt.toISOString(),
    tenants: due.filter((row) => Boolean(row.tenantId)).length,
    attempted,
    accepted,
    simulated,
    pending,
    blocked,
  };
}
