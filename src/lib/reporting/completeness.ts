/**
 * Reporting completeness: what is missing, not just what is present.
 *
 * A BI screen that only sums the rows it has will happily report a record week as a
 * quiet one. These functions count the days that should exist, the days that do, and
 * the records that arrived after the fact, so a gap looks like a gap.
 */

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return days;
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

export interface CompletenessAccount {
  locationId: string;
  workerId: string;
  businessDate: Date;
  status: string;
  submittedAt: Date | null;
}

export interface CompletenessWorker {
  id: string;
  fullName: string;
  locationId: string | null;
  status: string;
}

export interface CompletenessBranch {
  id: string;
  name: string;
}

export interface BranchCompleteness {
  locationId: string;
  locationName: string;
  expectedDays: number;
  submittedDays: number;
  missingDays: string[];
  lateDays: number;
  operators: number;
  operatorsWithoutClose: number;
  coveragePct: number;
}

export interface CompletenessReport {
  from: string;
  to: string;
  days: number;
  branches: BranchCompleteness[];
  totals: {
    expectedDays: number;
    submittedDays: number;
    missingDays: number;
    lateDays: number;
    coveragePct: number;
  };
  operatorsWithoutClose: Array<{ id: string; fullName: string; locationId: string | null }>;
  notes: string[];
}

/** A close is late when it arrives more than this many days after the business date. */
export const LATE_SUBMISSION_DAYS = 1;

const COUNTS_AS_SUBMITTED = new Set(["submitted", "reviewed", "corrected", "approved"]);

export function computeCompleteness(input: {
  from: string;
  to: string;
  branches: CompletenessBranch[];
  workers: CompletenessWorker[];
  accounts: CompletenessAccount[];
}): CompletenessReport {
  const days = eachDay(input.from, input.to);
  const dayKeys = new Set(days);

  const closed = input.accounts.filter(
    (row) => COUNTS_AS_SUBMITTED.has(row.status) && dayKeys.has(row.businessDate.toISOString().slice(0, 10))
  );

  const branches: BranchCompleteness[] = input.branches.map((branch) => {
    const branchCloses = closed.filter((row) => row.locationId === branch.id);
    const submittedDayKeys = new Set(
      branchCloses.map((row) => row.businessDate.toISOString().slice(0, 10))
    );
    const missingDays = days.filter((day) => !submittedDayKeys.has(day));
    const lateDays = branchCloses.filter((row) => {
      if (!row.submittedAt) return false;
      const businessDay = new Date(`${row.businessDate.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return (
        row.submittedAt.getTime() - businessDay.getTime() >
        LATE_SUBMISSION_DAYS * 86_400_000
      );
    }).length;
    const branchWorkers = input.workers.filter(
      (worker) => worker.locationId === branch.id && worker.status === "active"
    );
    const operatorsWithClose = new Set(branchCloses.map((row) => row.workerId));
    return {
      locationId: branch.id,
      locationName: branch.name,
      expectedDays: days.length,
      submittedDays: submittedDayKeys.size,
      missingDays,
      lateDays,
      operators: branchWorkers.length,
      operatorsWithoutClose: branchWorkers.filter((worker) => !operatorsWithClose.has(worker.id))
        .length,
      coveragePct: days.length === 0 ? 0 : Math.round((submittedDayKeys.size / days.length) * 100),
    };
  });

  const totalExpected = branches.reduce((sum, row) => sum + row.expectedDays, 0);
  const totalSubmitted = branches.reduce((sum, row) => sum + row.submittedDays, 0);
  const totalLate = branches.reduce((sum, row) => sum + row.lateDays, 0);

  const operatorsWithoutClose = input.workers
    .filter((worker) => worker.status === "active")
    .filter((worker) => !closed.some((row) => row.workerId === worker.id))
    .map((worker) => ({
      id: worker.id,
      fullName: worker.fullName,
      locationId: worker.locationId,
    }));

  const notes: string[] = [
    "Expected days count every day in the period for every active branch. A day a branch was closed by an administrator still counts, so the gap is visible and explainable.",
    `A close submitted more than ${LATE_SUBMISSION_DAYS} day after its business date is counted as late.`,
  ];
  if (totalSubmitted === 0) {
    notes.push(
      "No close was submitted anywhere in this period, so no figure in this report is a trend."
    );
  }
  if (operatorsWithoutClose.length > 0) {
    notes.push(
      `${operatorsWithoutClose.length} active operator${operatorsWithoutClose.length === 1 ? " has" : "s have"} no close in this period.`
    );
  }

  return {
    from: input.from,
    to: input.to,
    days: days.length,
    branches,
    totals: {
      expectedDays: totalExpected,
      submittedDays: totalSubmitted,
      missingDays: totalExpected - totalSubmitted,
      lateDays: totalLate,
      coveragePct: totalExpected === 0 ? 0 : Math.round((totalSubmitted / totalExpected) * 100),
    },
    operatorsWithoutClose,
    notes,
  };
}
