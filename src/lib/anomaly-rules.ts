/**
 * Deterministic anomaly rules.
 *
 * Every finding names the rule, the measured value and the threshold that was
 * crossed, and points at the supporting record. There is no scoring model, no
 * probability and no AI classification: the same input always produces the same
 * findings.
 */

export const ANOMALY_THRESHOLDS = {
  /** A reconciled daily account short or over by this much is a finding. */
  dailyDifference: 50,
  dailyDifferenceHigh: 500,
  /** A single principal transaction at or above this value. */
  largeTransaction: 5_000,
  largeTransactionHigh: 20_000,
  /** Count of shortage days per worker in the lookback window. */
  repeatedShortages: 3,
  /** Count of reversals/corrections per worker in the lookback window. */
  repeatedReversals: 3,
  /** A submitted account not reviewed for this many days. */
  unreviewedDays: 3,
  /** Approved/dispatched transfer not completed for this many days. */
  staleTransferDays: 2,
  /** Submitted handover not confirmed for this many hours. */
  unconfirmedHandoverHours: 24,
  /** Expense spike multiple of the location's median confirmed day. */
  expenseSpikeMultiple: 3,
  expenseSpikeFloor: 100,
  /** Count of shift variances per outgoing employee in the month. */
  repeatedShiftVariances: 3,
} as const;

export const ANOMALY_RULE_CATALOG = [
  {
    key: "daily_shortage",
    label: "Cash shortage on a reconciled day",
    description: "Confirmed daily account short by the configured amount.",
  },
  {
    key: "daily_overage",
    label: "Cash overage on a reconciled day",
    description: "Confirmed daily account over by the configured amount.",
  },
  {
    key: "repeated_shortage",
    label: "Repeated shortages by one employee",
    description: "Three or more shortage days for the same employee in the period.",
  },
  {
    key: "unreviewed_account",
    label: "Submitted account not reviewed",
    description: "A submitted daily account has waited longer than the review threshold.",
  },
  {
    key: "missing_account",
    label: "No daily account recorded",
    description: "An operating branch has no account for a completed day.",
  },
  {
    key: "large_transaction",
    label: "Large principal transaction",
    description: "A recorded cash-in or cash-out at or above the large-value threshold.",
  },
  {
    key: "repeated_reversal",
    label: "Repeated reversals or corrections",
    description: "The same employee reversed or corrected three or more entries.",
  },
  {
    key: "expense_spike",
    label: "Expense spike against the branch median",
    description: "Daily expenses at least three times the branch median and above the floor.",
  },
  {
    key: "transfer_variance",
    label: "Branch transfer variance",
    description: "A transfer was received with a difference or is under investigation.",
  },
  {
    key: "stale_transfer",
    label: "Transfer stuck after approval",
    description: "An approved or dispatched transfer has not completed within two days.",
  },
  {
    key: "shift_variance",
    label: "Shift handover variance",
    description: "The outgoing and receiving counts did not agree.",
  },
  {
    key: "repeated_shift_variance",
    label: "Repeated shift variances by one employee",
    description: "Three or more shift handover variances for the same outgoing employee.",
  },
  {
    key: "unconfirmed_handover",
    label: "Handover not confirmed",
    description: "A submitted handover has waited longer than the confirmation threshold.",
  },
  {
    key: "mixed_aggregate_ledger",
    label: "Aggregate close with ledger activity",
    description:
      "A day closed from aggregate totals has individual transaction rows for the same branch and date.",
  },
] as const;

export type AnomalySeverity = "high" | "medium" | "low";

export interface AnomalyAccountRow {
  id: string;
  locationId: string;
  locationName: string;
  workerId: string;
  workerName: string;
  businessDate: Date | string;
  status: string;
  submittedAt: Date | string | null;
  reviewedAt: Date | string | null;
  totalExpenses: unknown;
  calculatedDifference: unknown;
  /** aggregate | ledger */
  ledgerMode: string;
}

export interface AnomalyTransactionRow {
  id: string;
  type: string;
  amount: unknown;
  status: string;
  businessDate: Date | string;
  locationId: string;
  locationName: string;
  workerId: string;
  workerName: string;
  reference: string;
  isReversal: boolean;
}

export interface AnomalyTransferRow {
  id: string;
  reference: string;
  status: string;
  amount: unknown;
  variance: unknown;
  sourceLocationId: string;
  destinationLocationId: string;
  approvedAt: Date | string | null;
  dispatchedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AnomalyHandoverRow {
  id: string;
  shiftId: string;
  status: string;
  outgoingUserId: string;
  outgoingUserName: string;
  cashVariance: unknown;
  floatVariance: unknown;
  createdAt: Date | string;
  confirmedAt: Date | string | null;
  businessDate: Date | string;
  locationId: string;
  locationName: string;
}

export interface AnomalyInput {
  from: string;
  to: string;
  now: Date | string;
  locations: Array<{ id: string; name: string }>;
  accounts: AnomalyAccountRow[];
  transactions: AnomalyTransactionRow[];
  transfers: AnomalyTransferRow[];
  handovers: AnomalyHandoverRow[];
}

export interface AnomalyFinding {
  fingerprint: string;
  ruleKey: string;
  severity: AnomalySeverity;
  title: string;
  summary: string;
  entityType: string;
  entityId: string;
  locationId: string | null;
  workerId: string | null;
  businessDate: string | null;
  metricValue: number | null;
  thresholdValue: number | null;
  evidence: Record<string, unknown>;
}

function money(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round((parsed + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function dayKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function monthKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 7);
}

function labelDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cedi(value: number): string {
  return `GH₵${Math.abs(value).toFixed(2)}`;
}

function ageDays(value: Date | string, now: Date): number {
  return (now.getTime() - new Date(value).getTime()) / 86_400_000;
}

function severityRank(severity: AnomalySeverity): number {
  return severity === "high" ? 0 : severity === "medium" ? 1 : 2;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const CONFIRMED = new Set(["submitted", "reviewed"]);

export function evaluateAnomalies(input: AnomalyInput): AnomalyFinding[] {
  const now = new Date(input.now);
  const findings: AnomalyFinding[] = [];
  const accounts = input.accounts.filter(
    (row) => dayKey(row.businessDate) >= input.from && dayKey(row.businessDate) <= input.to
  );
  const confirmed = accounts.filter((row) => CONFIRMED.has(row.status));

  for (const account of confirmed) {
    const difference = money(account.calculatedDifference);
    if (difference <= -ANOMALY_THRESHOLDS.dailyDifference) {
      const severity: AnomalySeverity =
        Math.abs(difference) >= ANOMALY_THRESHOLDS.dailyDifferenceHigh ? "high" : "medium";
      findings.push({
        fingerprint: `daily_shortage:${account.id}`,
        ruleKey: "daily_shortage",
        severity,
        title: `Cash shortage at ${account.locationName}`,
        summary: `${account.workerName}'s ${labelDate(account.businessDate)} account is ${cedi(
          difference
        )} short after reconciliation.`,
        entityType: "dailyAccount",
        entityId: account.id,
        locationId: account.locationId,
        workerId: account.workerId,
        businessDate: dayKey(account.businessDate),
        metricValue: Math.abs(difference),
        thresholdValue: ANOMALY_THRESHOLDS.dailyDifference,
        evidence: {
          difference,
          status: account.status,
          threshold: ANOMALY_THRESHOLDS.dailyDifference,
        },
      });
    }
    if (difference >= ANOMALY_THRESHOLDS.dailyDifference) {
      findings.push({
        fingerprint: `daily_overage:${account.id}`,
        ruleKey: "daily_overage",
        severity: "medium",
        title: `Cash overage at ${account.locationName}`,
        summary: `${account.workerName}'s ${labelDate(account.businessDate)} account is ${cedi(
          difference
        )} over. An overage is unexplained money, not profit.`,
        entityType: "dailyAccount",
        entityId: account.id,
        locationId: account.locationId,
        workerId: account.workerId,
        businessDate: dayKey(account.businessDate),
        metricValue: difference,
        thresholdValue: ANOMALY_THRESHOLDS.dailyDifference,
        evidence: { difference, status: account.status },
      });
    }
    if (account.ledgerMode !== "ledger") {
      const sameDayLedger = input.transactions.filter(
        (row) =>
          row.status === "recorded" &&
          row.locationId === account.locationId &&
          dayKey(row.businessDate) === dayKey(account.businessDate)
      );
      if (sameDayLedger.length > 0) {
        findings.push({
          fingerprint: `mixed_aggregate_ledger:${account.id}`,
          ruleKey: "mixed_aggregate_ledger",
          severity: "medium",
          title: `Aggregate close with ledger activity at ${account.locationName}`,
          summary: `${labelDate(account.businessDate)} was closed from day totals but ${
            sameDayLedger.length
          } transaction row${sameDayLedger.length === 1 ? "" : "s"} exist for the same branch and date. Confirm which source is authoritative.`,
          entityType: "dailyAccount",
          entityId: account.id,
          locationId: account.locationId,
          workerId: account.workerId,
          businessDate: dayKey(account.businessDate),
          metricValue: sameDayLedger.length,
          thresholdValue: null,
          evidence: {
            ledgerMode: account.ledgerMode,
            transactionCount: sameDayLedger.length,
            transactionReferences: sameDayLedger
              .slice(0, 5)
              .map((row) => row.reference),
          },
        });
      }
    }

    if (
      account.status === "submitted" &&
      account.submittedAt &&
      ageDays(account.submittedAt, now) >= ANOMALY_THRESHOLDS.unreviewedDays
    ) {
      findings.push({
        fingerprint: `unreviewed_account:${account.id}`,
        ruleKey: "unreviewed_account",
        severity: "medium",
        title: `Account waiting for review at ${account.locationName}`,
        summary: `${labelDate(account.businessDate)} was submitted ${Math.floor(
          ageDays(account.submittedAt, now)
        )} days ago and is still not reviewed.`,
        entityType: "dailyAccount",
        entityId: account.id,
        locationId: account.locationId,
        workerId: account.workerId,
        businessDate: dayKey(account.businessDate),
        metricValue: Math.floor(ageDays(account.submittedAt, now)),
        thresholdValue: ANOMALY_THRESHOLDS.unreviewedDays,
        evidence: { submittedAt: account.submittedAt },
      });
    }
  }

  // Repeated shortages in the selected window, keyed by month so a resolution
  // does not suppress an identical pattern in a later month.
  const shortagesByWorker = new Map<string, AnomalyAccountRow[]>();
  for (const account of confirmed) {
    if (money(account.calculatedDifference) < 0) {
      const rows = shortagesByWorker.get(account.workerId) ?? [];
      rows.push(account);
      shortagesByWorker.set(account.workerId, rows);
    }
  }
  for (const [workerId, rows] of shortagesByWorker) {
    if (rows.length < ANOMALY_THRESHOLDS.repeatedShortages) continue;
    const first = rows[0];
    findings.push({
      fingerprint: `repeated_shortage:${workerId}:${monthKey(input.to)}`,
      ruleKey: "repeated_shortage",
      severity: "high",
      title: `Repeated shortages by ${first.workerName}`,
      summary: `${rows.length} shortage days for ${first.workerName} between ${labelDate(
        input.from
      )} and ${labelDate(input.to)}.`,
      entityType: "user",
      entityId: workerId,
      locationId: first.locationId,
      workerId,
      businessDate: input.to,
      metricValue: rows.length,
      thresholdValue: ANOMALY_THRESHOLDS.repeatedShortages,
      evidence: {
        days: rows.map((row) => ({
          date: dayKey(row.businessDate),
          difference: money(row.calculatedDifference),
          accountId: row.id,
        })),
      },
    });
  }

  // Missing accounts for the two completed days before "to", only for branches
  // that actually recorded at least one account in the window.
  const toDate = new Date(`${input.to}T00:00:00.000Z`);
  const locationHasActivity = new Set(accounts.map((row) => row.locationId));
  for (const location of input.locations) {
    if (!locationHasActivity.has(location.id)) continue;
    for (const offset of [2, 1]) {
      const date = new Date(toDate.getTime() - offset * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (date < input.from) continue;
      const exists = accounts.some(
        (row) => row.locationId === location.id && dayKey(row.businessDate) === date
      );
      if (exists) continue;
      findings.push({
        fingerprint: `missing_account:${location.id}:${date}`,
        ruleKey: "missing_account",
        severity: "low",
        title: `No daily account for ${location.name}`,
        summary: `No account was recorded for ${labelDate(date)}. If the branch was closed this can be resolved as explained.`,
        entityType: "location",
        entityId: location.id,
        locationId: location.id,
        workerId: null,
        businessDate: date,
        metricValue: null,
        thresholdValue: null,
        evidence: { date, locationId: location.id },
      });
    }
  }

  // Expense spikes against the branch's own median confirmed day.
  const expensesByLocation = new Map<string, number[]>();
  for (const account of confirmed) {
    const rows = expensesByLocation.get(account.locationId) ?? [];
    rows.push(money(account.totalExpenses));
    expensesByLocation.set(account.locationId, rows);
  }
  for (const account of confirmed) {
    const all = expensesByLocation.get(account.locationId) ?? [];
    const others = confirmed
      .filter((row) => row.locationId === account.locationId && row.id !== account.id)
      .map((row) => money(row.totalExpenses));
    if (others.length < 3) continue;
    const baseline = median(others);
    const expense = money(account.totalExpenses);
    if (
      baseline > 0 &&
      expense >= ANOMALY_THRESHOLDS.expenseSpikeFloor &&
      expense >= baseline * ANOMALY_THRESHOLDS.expenseSpikeMultiple
    ) {
      findings.push({
        fingerprint: `expense_spike:${account.id}`,
        ruleKey: "expense_spike",
        severity: "medium",
        title: `Expense spike at ${account.locationName}`,
        summary: `${labelDate(account.businessDate)} expenses were ${cedi(
          expense
        )}, at least three times the branch median of ${cedi(baseline)}.`,
        entityType: "dailyAccount",
        entityId: account.id,
        locationId: account.locationId,
        workerId: account.workerId,
        businessDate: dayKey(account.businessDate),
        metricValue: expense,
        thresholdValue: Math.round(baseline * ANOMALY_THRESHOLDS.expenseSpikeMultiple * 100) / 100,
        evidence: {
          expense,
          median: baseline,
          multiple: ANOMALY_THRESHOLDS.expenseSpikeMultiple,
          sampleDays: all.length,
        },
      });
    }
  }

  for (const transaction of input.transactions) {
    const amount = Math.abs(money(transaction.amount));
    if (transaction.status !== "recorded") {
      // Reversals are counted below, not treated as principal volume.
    } else if (amount >= ANOMALY_THRESHOLDS.largeTransaction) {
      findings.push({
        fingerprint: `large_transaction:${transaction.id}`,
        ruleKey: "large_transaction",
        severity:
          amount >= ANOMALY_THRESHOLDS.largeTransactionHigh ? "high" : "medium",
        title: `Large ${transaction.type.replace(/_/g, " ")} at ${transaction.locationName}`,
        summary: `${cedi(amount)} recorded by ${transaction.workerName} on ${labelDate(
          transaction.businessDate
        )} (reference ${transaction.reference}).`,
        entityType: "momoTransaction",
        entityId: transaction.id,
        locationId: transaction.locationId,
        workerId: transaction.workerId,
        businessDate: dayKey(transaction.businessDate),
        metricValue: amount,
        thresholdValue: ANOMALY_THRESHOLDS.largeTransaction,
        evidence: {
          type: transaction.type,
          reference: transaction.reference,
          amount,
        },
      });
    }
  }

  const reversalsByWorker = new Map<string, AnomalyTransactionRow[]>();
  for (const transaction of input.transactions) {
    if (!transaction.isReversal) continue;
    const rows = reversalsByWorker.get(transaction.workerId) ?? [];
    rows.push(transaction);
    reversalsByWorker.set(transaction.workerId, rows);
  }
  for (const [workerId, rows] of reversalsByWorker) {
    if (rows.length < ANOMALY_THRESHOLDS.repeatedReversals) continue;
    const first = rows[0];
    findings.push({
      fingerprint: `repeated_reversal:${workerId}:${monthKey(input.to)}`,
      ruleKey: "repeated_reversal",
      severity: "medium",
      title: `Repeated reversals or corrections by ${first.workerName}`,
      summary: `${rows.length} reversal entries by ${first.workerName} in the selected period.`,
      entityType: "user",
      entityId: workerId,
      locationId: first.locationId,
      workerId,
      businessDate: input.to,
      metricValue: rows.length,
      thresholdValue: ANOMALY_THRESHOLDS.repeatedReversals,
      evidence: {
        references: rows.slice(0, 20).map((row) => row.reference),
      },
    });
  }

  for (const transfer of input.transfers) {
    const variance = money(transfer.variance);
    if (transfer.status === "variance_investigation" || Math.abs(variance) >= 0.01) {
      findings.push({
        fingerprint: `transfer_variance:${transfer.id}`,
        ruleKey: "transfer_variance",
        severity: "high",
        title: `Transfer variance on ${transfer.reference}`,
        summary: `The receiving branch counted a difference of ${cedi(variance)} on a ${cedi(
          money(transfer.amount)
        )} transfer.`,
        entityType: "branchTransfer",
        entityId: transfer.id,
        locationId: transfer.sourceLocationId,
        workerId: null,
        businessDate: dayKey(transfer.createdAt),
        metricValue: Math.abs(variance),
        thresholdValue: 0,
        evidence: { status: transfer.status, variance, amount: money(transfer.amount) },
      });
    }
    if (
      (transfer.status === "approved" || transfer.status === "dispatched") &&
      ageDays(transfer.dispatchedAt ?? transfer.approvedAt ?? transfer.updatedAt, now) >=
        ANOMALY_THRESHOLDS.staleTransferDays
    ) {
      findings.push({
        fingerprint: `stale_transfer:${transfer.id}`,
        ruleKey: "stale_transfer",
        severity: "medium",
        title: `Transfer not completed: ${transfer.reference}`,
        summary: `The transfer has been ${transfer.status} for more than ${ANOMALY_THRESHOLDS.staleTransferDays} days without a receiving confirmation.`,
        entityType: "branchTransfer",
        entityId: transfer.id,
        locationId: transfer.sourceLocationId,
        workerId: null,
        businessDate: dayKey(transfer.createdAt),
        metricValue: Math.floor(
          ageDays(transfer.dispatchedAt ?? transfer.approvedAt ?? transfer.updatedAt, now)
        ),
        thresholdValue: ANOMALY_THRESHOLDS.staleTransferDays,
        evidence: {
          status: transfer.status,
          amount: money(transfer.amount),
          sourceLocationId: transfer.sourceLocationId,
          destinationLocationId: transfer.destinationLocationId,
        },
      });
    }
  }

  const shiftVarianceByWorker = new Map<string, AnomalyHandoverRow[]>();
  for (const handover of input.handovers) {
    const cash = money(handover.cashVariance);
    const float = money(handover.floatVariance);
    if (cash !== 0 || float !== 0) {
      findings.push({
        fingerprint: `shift_variance:${handover.id}`,
        ruleKey: "shift_variance",
        severity: "high",
        title: `Shift handover variance at ${handover.locationName}`,
        summary: `${handover.outgoingUserName}'s ${labelDate(
          handover.businessDate
        )} handover has a cash difference of ${cedi(cash)} and float difference of ${cedi(
          float
        )}.`,
        entityType: "shiftHandover",
        entityId: handover.id,
        locationId: handover.locationId,
        workerId: handover.outgoingUserId,
        businessDate: dayKey(handover.businessDate),
        metricValue: Math.abs(cash) + Math.abs(float),
        thresholdValue: 0,
        evidence: { cashVariance: cash, floatVariance: float, status: handover.status },
      });
      const rows = shiftVarianceByWorker.get(handover.outgoingUserId) ?? [];
      rows.push(handover);
      shiftVarianceByWorker.set(handover.outgoingUserId, rows);
    }
    if (
      handover.status === "awaiting_receipt" &&
      ageDays(handover.createdAt, now) * 24 >= ANOMALY_THRESHOLDS.unconfirmedHandoverHours
    ) {
      findings.push({
        fingerprint: `unconfirmed_handover:${handover.id}`,
        ruleKey: "unconfirmed_handover",
        severity: "medium",
        title: `Handover still unconfirmed at ${handover.locationName}`,
        summary: `${handover.outgoingUserName}'s handover has waited more than ${ANOMALY_THRESHOLDS.unconfirmedHandoverHours} hours for the receiving employee.`,
        entityType: "shiftHandover",
        entityId: handover.id,
        locationId: handover.locationId,
        workerId: handover.outgoingUserId,
        businessDate: dayKey(handover.businessDate),
        metricValue: Math.floor(ageDays(handover.createdAt, now) * 24),
        thresholdValue: ANOMALY_THRESHOLDS.unconfirmedHandoverHours,
        evidence: { createdAt: handover.createdAt, status: handover.status },
      });
    }
  }

  for (const [workerId, rows] of shiftVarianceByWorker) {
    if (rows.length < ANOMALY_THRESHOLDS.repeatedShiftVariances) continue;
    const first = rows[0];
    findings.push({
      fingerprint: `repeated_shift_variance:${workerId}:${monthKey(input.to)}`,
      ruleKey: "repeated_shift_variance",
      severity: "high",
      title: `Repeated shift variances by ${first.outgoingUserName}`,
      summary: `${rows.length} shift handover variances for ${first.outgoingUserName} in the selected period.`,
      entityType: "user",
      entityId: workerId,
      locationId: first.locationId,
      workerId,
      businessDate: input.to,
      metricValue: rows.length,
      thresholdValue: ANOMALY_THRESHOLDS.repeatedShiftVariances,
      evidence: {
        handovers: rows.map((row) => ({
          id: row.id,
          date: dayKey(row.businessDate),
          cashVariance: money(row.cashVariance),
          floatVariance: money(row.floatVariance),
        })),
      },
    });
  }

  return findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.ruleKey.localeCompare(b.ruleKey) ||
      (a.businessDate ?? "").localeCompare(b.businessDate ?? "") ||
      a.entityId.localeCompare(b.entityId)
  );
}
