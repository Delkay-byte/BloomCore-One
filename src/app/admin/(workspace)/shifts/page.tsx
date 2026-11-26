"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import ShiftStatusBadge from "@/components/momo/ShiftStatusBadge";
import { StatCard } from "@/components/ui/DataDisplay";
import {
  getAdminShiftBoard,
  getShiftEmployees,
  type ShiftBoardView,
} from "@/lib/actions/shift.actions";

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminShiftsPage() {
  const [data, setData] = useState<ShiftBoardView | null>(null);
  const [employees, setEmployees] = useState<
    Array<{ id: string; fullName: string; role: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({
    dateFrom: "",
    dateTo: "",
    locationId: "",
    employeeId: "",
    status: "all",
  });

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const [board, staff] = await Promise.all([
        getAdminShiftBoard(filters),
        getShiftEmployees(),
      ]);
      setData(board);
      setEmployees(staff);
    } catch {
      setError("The shift board could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Shifts &amp; handovers</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Employee-level accountability for the money in the branch. A handover
            needs both the outgoing and the receiving employee before it closes.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Shift figures are accountability snapshots. They are shown here for
        employee accountability and are <strong>not</strong> added into daily
        account totals, so the same cash is never counted twice.
      </p>

      {error && <Notice type="error">{error}</Notice>}

      <section className="card p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="text-xs font-medium text-slate-600">
            From
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(event) =>
                setFilters((current) => ({ ...current, dateFrom: event.target.value }))
              }
              className="input mt-1 w-full"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input
              type="date"
              value={filters.dateTo}
              onChange={(event) =>
                setFilters((current) => ({ ...current, dateTo: event.target.value }))
              }
              className="input mt-1 w-full"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Location
            <select
              value={filters.locationId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, locationId: event.target.value }))
              }
              className="input mt-1 w-full"
            >
              <option value="">All locations</option>
              {data?.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Employee
            <select
              value={filters.employeeId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, employeeId: event.target.value }))
              }
              className="input mt-1 w-full"
            >
              <option value="">All employees</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Status
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({ ...current, status: event.target.value }))
              }
              className="input mt-1 w-full"
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="awaiting_handover">Awaiting handover</option>
              <option value="variance_open">Variance open</option>
              <option value="closed">Closed</option>
              <option value="draft">Draft</option>
            </select>
          </label>
        </div>
      </section>

      {loading && !data ? (
        <p className="text-sm text-slate-500">Loading shift accountability…</p>
      ) : data ? (
        <>
          <section className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Shifts" value={data.totals.shifts} icon={<Clock3 />} />
            <StatCard label="Open" value={data.totals.open} tone="warning" />
            <StatCard
              label="Awaiting handover"
              value={data.totals.awaitingHandover}
              tone="warning"
            />
            <StatCard
              label="Variance open"
              value={data.totals.varianceOpen}
              tone={data.totals.varianceOpen > 0 ? "negative" : "positive"}
            />
            <StatCard label="Closed" value={data.totals.closed} tone="positive" />
            <StatCard
              label="Net handover variance"
              value={
                <CediAmount
                  amount={data.totals.cashVariance + data.totals.floatVariance}
                  showSign
                />
              }
              tone={
                Math.abs(data.totals.cashVariance + data.totals.floatVariance) > 0
                  ? "warning"
                  : "positive"
              }
              icon={<ShieldCheck />}
            />
          </section>

          {data.totals.varianceOpen > 0 && (
            <Notice type="warning" popup={false}>
              {data.totals.varianceOpen} handover
              {data.totals.varianceOpen === 1 ? "" : "s"} have an unresolved
              variance. The record stays open until an administrator records an
              investigation outcome.
            </Notice>
          )}

          {data.awaitingHandovers.length > 0 && (
            <section className="card p-4">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <Clock3 className="h-4 w-4 text-amber-600" aria-hidden />
                Waiting for the receiving employee
              </h2>
              <ul className="mt-3 divide-y divide-slate-100">
                {data.awaitingHandovers.map((handover) => (
                  <li
                    key={handover.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      <strong>{handover.outgoingUserName ?? "Outgoing employee"}</strong>{" "}
                      declared{" "}
                      <CediAmount amount={handover.outgoingCash} /> cash and{" "}
                      <CediAmount amount={handover.outgoingMomoFloat} /> float
                    </span>
                    <span className="text-xs text-slate-500">
                      Receiver: {handover.incomingUserName ?? "unassigned"} ·{" "}
                      {fmtDate(handover.createdAt)} {fmtTime(handover.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <Users className="h-4 w-4 text-brand-600" aria-hidden />
                Employee accountability
              </h2>
              <p className="text-xs text-slate-500">Variance totals per employee</p>
            </div>
            {data.stats.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                No shifts match these filters.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Employee</th>
                      <th className="px-4 py-2 text-right">Shifts</th>
                      <th className="px-4 py-2 text-right">Open</th>
                      <th className="px-4 py-2 text-right">Awaiting handover</th>
                      <th className="px-4 py-2 text-right">Closed</th>
                      <th className="px-4 py-2 text-right">Variance open</th>
                      <th className="px-4 py-2 text-right">Cash variance</th>
                      <th className="px-4 py-2 text-right">Float variance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.stats.map((stat) => (
                      <tr key={stat.userId}>
                        <td className="px-4 py-2 font-medium text-slate-800">
                          {stat.fullName}
                        </td>
                        <td className="px-4 py-2 text-right tnum">{stat.shiftCount}</td>
                        <td className="px-4 py-2 text-right tnum">{stat.openCount}</td>
                        <td className="px-4 py-2 text-right tnum">
                          {stat.awaitingHandover}
                        </td>
                        <td className="px-4 py-2 text-right tnum">{stat.closedCount}</td>
                        <td className="px-4 py-2 text-right tnum">
                          {stat.varianceCount}
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={stat.totalCashVariance} showSign />
                        </td>
                        <td className="px-4 py-2 text-right tnum">
                          <CediAmount amount={stat.totalFloatVariance} showSign />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Shift records</h2>
              <p className="text-xs text-slate-500">
                {data.shifts.length} shown, newest first
              </p>
            </div>
            {data.shifts.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">
                No shifts match these filters.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Date</th>
                      <th className="px-4 py-2">Shift</th>
                      <th className="px-4 py-2">Employee</th>
                      <th className="px-4 py-2">Location</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2 text-right">Opening cash</th>
                      <th className="px-4 py-2 text-right">Opening float</th>
                      <th className="px-4 py-2 text-right">Closing cash</th>
                      <th className="px-4 py-2 text-right">Closing float</th>
                      <th className="px-4 py-2 text-right">Variance</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.shifts.map((shift) => {
                      const variance =
                        (shift.handovers[0]?.cashVariance ?? 0) +
                        (shift.handovers[0]?.floatVariance ?? 0);
                      return (
                        <tr key={shift.id} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                            {fmtDate(shift.businessDate)}
                          </td>
                          <td className="px-4 py-2">
                            <span className="font-medium text-slate-800">
                              {shift.label}
                            </span>
                            <span className="block text-[11px] text-slate-400">
                              {shift.reference}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-slate-700">
                            {shift.assignedUserName ?? "—"}
                          </td>
                          <td className="px-4 py-2 text-slate-600">
                            {shift.locationName}
                          </td>
                          <td className="px-4 py-2">
                            <ShiftStatusBadge status={shift.status} label={shift.statusLabel} />
                          </td>
                          <td className="px-4 py-2 text-right tnum">
                            <CediAmount amount={shift.openingCash} />
                          </td>
                          <td className="px-4 py-2 text-right tnum">
                            <CediAmount amount={shift.openingMomoFloat} />
                          </td>
                          <td className="px-4 py-2 text-right tnum">
                            {shift.closingCash === null ? (
                              "—"
                            ) : (
                              <CediAmount amount={shift.closingCash} />
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tnum">
                            {shift.closingMomoFloat === null ? (
                              "—"
                            ) : (
                              <CediAmount amount={shift.closingMomoFloat} />
                            )}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tnum ${
                              Math.abs(variance) > 0 ? "font-semibold text-amber-700" : ""
                            }`}
                          >
                            {shift.handovers.length === 0 ? (
                              "—"
                            ) : (
                              <CediAmount amount={variance} showSign />
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Link
                              href={`/admin/shifts/${shift.id}`}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
                            >
                              Review <ArrowRight className="h-3 w-3" aria-hidden />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.totals.varianceOpen > 0 && (
            <p className="flex items-center gap-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Open the shift record to review both sides and record the
              investigation outcome.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
