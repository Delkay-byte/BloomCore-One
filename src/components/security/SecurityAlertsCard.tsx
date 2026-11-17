"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import {
  getSecurityAlerts,
  markSecurityAlertsRead,
  type SecurityAlertView,
} from "@/lib/actions/security-alerts.actions";

/**
 * Residual C: the in-app security alert queue.
 *
 * Alerts are read from the server with a session-derived scope. The component
 * never receives another tenant's alerts and cannot mark them read.
 */
export default function SecurityAlertsCard() {
  const [alerts, setAlerts] = useState<SecurityAlertView[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const rows = await getSecurityAlerts();
    setAlerts(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unread = alerts.filter((alert) => !alert.read);

  async function markAllRead() {
    const ids = unread.map((alert) => alert.id);
    if (ids.length === 0) return;
    await markSecurityAlertsRead(ids);
    setAlerts((current) =>
      current.map((alert) => ({ ...alert, read: true }))
    );
  }

  if (loading || alerts.length === 0) return null;

  return (
    <section className="card" aria-labelledby="security-alerts-title">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-amber-50 p-2 text-amber-700">
            <ShieldAlert size={18} aria-hidden />
          </span>
          <div>
            <h2 id="security-alerts-title" className="text-base font-semibold text-slate-900">
              Security alerts
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {unread.length > 0
                ? `${unread.length} unread notification${unread.length === 1 ? "" : "s"} from the security log.`
                : "No unread security notifications."}
            </p>
          </div>
        </div>
        {unread.length > 0 && (
          <button type="button" className="btn btn-secondary" onClick={markAllRead}>
            Mark all read
          </button>
        )}
      </div>

      <ul className="mt-4 divide-y divide-slate-100">
        {alerts.slice(0, 5).map((alert) => (
          <li key={alert.id} className="py-3">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  alert.severity === "critical"
                    ? "bg-red-50 text-red-700"
                    : "bg-amber-50 text-amber-800"
                }`}
              >
                {alert.severity}
              </span>
              {!alert.read && (
                <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">
                  New
                </span>
              )}
              <span className="ml-auto text-xs text-slate-400">
                {new Date(alert.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="mt-1 text-sm font-medium text-slate-900">{alert.title}</p>
            <p className="mt-0.5 text-sm text-slate-600">{alert.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
