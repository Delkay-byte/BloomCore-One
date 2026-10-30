"use client";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/utils";

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
}

/** Map raw action codes to friendly, human-readable labels. */
function friendlyAction(action: string): string {
  const map: Record<string, string> = {
    "auth.login": "Signed in",
    "auth.logout": "Signed out",
    "auth.password_changed": "Changed password",
    "auth.first_login_password_changed": "Changed password (first login)",
    "auth.reauth_success": "Confirmed identity",
    "auth.reauth_failed": "Failed identity confirmation",
    "auth.workspace_selected": "Selected work area",
    "auth.workspace_switched": "Switched work area",
    "user.password_reset": "Reset a user's password",
    "user.module_assignment_changed": "Changed user's work access",
    "susu.contribution_recorded": "Recorded customer payment",
    "susu.collector_created": "Added a new collector",
    "susu.collector_activated": "Activated a collector",
    "susu.collector_deactivated": "Deactivated a collector",
    "susu.customer_assigned_to_collector": "Assigned customer to collector",
    "susu.customer_removed_from_collector": "Removed customer from collector",
    "susu.remittance_recorded": "Recorded collector money handed in",
    "susu.customer_reassigned": "Reassigned customer to a new collector",
    "daily_account.submitted": "Submitted today's MoMo account",
    "daily_account.reviewed": "Reviewed today's MoMo account",
  };
  return map[action] || action.replace(/_/g, " ").replace(/\./g, " — ");
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 30;
  const handleRedirect = useRedirectHandler();

  async function loadLogs() {
    setLoading(true);
    try {
      const result = await fetch(`/api/audit?page=${page}&limit=${limit}`);
      if (result.ok) {
        const data = await result.json();
        setLogs(data.logs);
        setTotal(data.total);
      }
    } catch (err) { if (handleRedirect(err, () => {}, "")) return; } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, [page]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Activity History</h1>
        <p className="text-gray-500 mt-1">A record of important actions performed in the system</p>
      </div>

      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner"></div>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-4xl mb-2">📝</p>
            <p className="font-medium">No audit entries yet</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td className="text-sm whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                      <td>
                        <span className="badge badge-blue text-xs">{friendlyAction(log.action)}</span>
                      </td>
                      <td className="text-sm">
                        <span className="font-medium">{log.entityType}</span>
                        {log.entityId && (
                          <span className="text-gray-400 ml-1 text-xs">
                            {log.entityId.substring(0, 8)}...
                          </span>
                        )}
                      </td>
                      <td className="text-sm text-gray-500 max-w-xs truncate">
                        {log.details || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
                <p className="text-sm text-gray-500">
                  Page {page} of {totalPages} ({total} entries)
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="btn btn-secondary btn-sm"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="btn btn-secondary btn-sm"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
