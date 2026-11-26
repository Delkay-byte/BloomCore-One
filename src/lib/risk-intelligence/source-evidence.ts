/**
 * Closed-record evidence for a contribution.
 *
 * A shared signal may only be built on a record this business owns and has
 * closed through its normal review. The reference is a factual pointer kept
 * inside the contributing tenant; it is never disclosed to another business.
 */

import { db } from "@/lib/db";

export interface ClosedSourceResult {
  ok: boolean;
  error?: string;
  reference?: string;
}

export async function closedSourceEvidence(input: {
  tenantId: string;
  subjectUserId: string;
  sourceType: string;
  sourceId: string;
}): Promise<ClosedSourceResult> {
  if (input.sourceType === "dailyAccount") {
    const row = await db.dailyAccount.findFirst({
      where: { id: input.sourceId, tenantId: input.tenantId },
      select: {
        id: true,
        workerId: true,
        businessDate: true,
        status: true,
        reviewedAt: true,
        differenceStatus: true,
      },
    });
    if (!row) return { ok: false, error: "That record is not one of your business's records." };
    if (row.workerId !== input.subjectUserId) {
      return {
        ok: false,
        error: "That daily account belongs to a different employee. A signal must be tied to the employee it concerns.",
      };
    }
    if (row.status !== "reviewed" || !row.reviewedAt) {
      return {
        ok: false,
        error: "Only a reviewed and closed daily account can support a shared signal.",
      };
    }
    return {
      ok: true,
      reference:
        "dailyAccount:" +
        row.id +
        " businessDate=" +
        row.businessDate.toISOString().slice(0, 10) +
        " differenceStatus=" +
        row.differenceStatus +
        " reviewedAt=" +
        row.reviewedAt.toISOString(),
    };
  }
  if (input.sourceType === "anomalyInvestigation") {
    const row = await db.anomalyInvestigation.findFirst({
      where: { id: input.sourceId, tenantId: input.tenantId },
      select: {
        id: true,
        anomalyId: true,
        status: true,
        disposition: true,
        closedAt: true,
        anomaly: { select: { workerId: true } },
      },
    });
    if (!row) return { ok: false, error: "That record is not one of your business's records." };
    if (row.anomaly.workerId !== input.subjectUserId) {
      return {
        ok: false,
        error: "That investigation concerns a different employee. A signal must be tied to the employee it concerns.",
      };
    }
    if (row.status !== "closed" || !row.closedAt) {
      return { ok: false, error: "Only a closed investigation can support a shared signal." };
    }
    if (row.disposition !== "genuine") {
      return {
        ok: false,
        error: "A false-positive or inconclusive investigation cannot be shared as a risk signal.",
      };
    }
    return {
      ok: true,
      reference:
        "anomalyInvestigation:" +
        row.id +
        " anomaly=" +
        row.anomalyId +
        " disposition=genuine closedAt=" +
        row.closedAt.toISOString(),
    };
  }
  if (input.sourceType === "reconciliationExceptionCase") {
    const row = await db.reconciliationExceptionCase.findFirst({
      where: { id: input.sourceId, tenantId: input.tenantId },
      select: {
        id: true,
        caseNumber: true,
        status: true,
        resolutionType: true,
        resolvedAt: true,
        links: { select: { entityType: true, entityId: true } },
      },
    });
    if (!row) return { ok: false, error: "That record is not one of your business's records." };
    if (row.status !== "resolved" || !row.resolvedAt || !row.resolutionType) {
      return {
        ok: false,
        error: "Only a resolved reconciliation case with a recorded resolution can be shared.",
      };
    }
    const dailyAccountIds = row.links
      .filter((link) => link.entityType === "dailyAccount")
      .map((link) => link.entityId);
    const shiftIds = row.links
      .filter((link) => link.entityType === "shift")
      .map((link) => link.entityId);
    const [linkedAccounts, linkedShifts] = await Promise.all([
      dailyAccountIds.length
        ? db.dailyAccount.findMany({
            where: { id: { in: dailyAccountIds }, tenantId: input.tenantId },
            select: { workerId: true },
          })
        : Promise.resolve([]),
      shiftIds.length
        ? db.shift.findMany({
            where: { id: { in: shiftIds }, tenantId: input.tenantId },
            select: { assignedUserId: true },
          })
        : Promise.resolve([]),
    ]);
    const directlyLinkedUser = row.links.some(
      (link) => link.entityType === "user" && link.entityId === input.subjectUserId
    );
    const linkedToSubject =
      directlyLinkedUser ||
      linkedAccounts.some((account) => account.workerId === input.subjectUserId) ||
      linkedShifts.some((shift) => shift.assignedUserId === input.subjectUserId);
    if (!linkedToSubject) {
      return {
        ok: false,
        error: "That reconciliation case is not linked to the selected employee's own record.",
      };
    }
    return {
      ok: true,
      reference:
        "reconciliationExceptionCase:" +
        row.id +
        " caseNumber=" +
        row.caseNumber +
        " resolutionType=" +
        row.resolutionType +
        " resolvedAt=" +
        row.resolvedAt.toISOString(),
    };
  }
  return { ok: false, error: "Unsupported source record type." };
}
