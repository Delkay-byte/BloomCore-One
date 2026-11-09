"use client";

import { SkeletonTable } from "@/components/ui/Skeletons";
import { ClipboardPen, Eye } from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import Modal from "@/components/ui/Modal";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/utils";
import type { AuditPresentation } from "@/lib/audit-presentation";

interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
  presentation: AuditPresentation;
}

function DetailFields({
  fields,
}: {
  fields: Array<{ label: string; value: string }>;
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-slate-500">No further details recorded.</p>;
  }
  return (
    <dl className="space-y-2 text-sm">
      {fields.map((field) => (
        <div key={field.label} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
          <dt className="text-slate-500">{field.label}</dt>
          <dd className="break-words font-medium text-slate-800">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecordCell({ record }: { record: AuditPresentation }) {
  return (
    <div className="min-w-0">
      <p className="font-medium text-slate-900">
        {record.entityReference || record.entityLabel}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        {record.entityReference ? record.entityLabel : null}
        {record.entityReference && record.entitySecondary ? " · " : null}
        {record.entitySecondary}
      </p>
    </div>
  );
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const limit = 30;
  const handleRedirect = useRedirectHandler();

  async function loadLogs() {
    setLoading(true);
    try {
      const result = await fetch(`/api/audit?page=${page}&limit=${limit}`, {
        cache: "no-store",
      });
      if (result.ok) {
        const data = await result.json();
        setLogs(data.logs);
        setTotal(data.total);
      }
    } catch (err) {
      if (handleRedirect(err, () => {}, "")) return;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const totalPages = Math.ceil(total / limit);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Activity History</h1>
        <p className="mt-1 text-slate-500">
          A record of important actions performed in the system. Select an activity
          to see its full details.
        </p>
      </div>

      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={4} />
        ) : logs.length === 0 ? (
          <div className="py-12 text-center text-slate-500">
            <p
              className="mb-2 flex justify-center text-brand-300 [&>svg]:h-9 [&>svg]:w-9"
              aria-hidden
            >
              <ClipboardPen size={36} />
            </p>
            <p className="font-medium">No activity recorded yet</p>
          </div>
        ) : (
          <>
            {/* Desktop and tablet table */}
            <div className="table-container hidden md:block">
              <table>
                <caption className="sr-only">
                  Activity history: date, action, related record and what happened
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Action</th>
                    <th scope="col">Related record</th>
                    <th scope="col">What happened</th>
                    <th scope="col">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td className="whitespace-nowrap text-sm">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td>
                        <span className="badge badge-blue text-xs">
                          {log.presentation.actionLabel}
                        </span>
                      </td>
                      <td className="max-w-[16rem] text-sm">
                        <RecordCell record={log.presentation} />
                      </td>
                      <td className="max-w-md text-sm text-slate-600">
                        <p className="line-clamp-2 break-words">
                          {log.presentation.description}
                        </p>
                      </td>
                      <td className="whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setSelected(log)}
                          className="btn btn-secondary btn-sm"
                          aria-label={`View details for ${log.presentation.actionLabel}`}
                        >
                          <Eye size={14} aria-hidden /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards: no horizontal guessing or clipped columns */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {logs.map((log) => (
                <li key={log.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-xs font-medium text-slate-500">
                      {formatDateTime(log.createdAt)}
                    </p>
                    <span className="badge badge-blue text-xs">
                      {log.presentation.actionLabel}
                    </span>
                  </div>
                  <div className="mt-2">
                    <RecordCell record={log.presentation} />
                  </div>
                  <p className="mt-2 break-words text-sm text-slate-600">
                    {log.presentation.description}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSelected(log)}
                    className="btn btn-secondary btn-sm mt-3 w-full"
                  >
                    <Eye size={14} aria-hidden /> View details
                  </button>
                </li>
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
                <p className="text-sm text-slate-500">
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

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.presentation.actionLabel ?? "Activity details"}
        description={
          selected
            ? `${formatDateTime(selected.createdAt)} · ${
                selected.presentation.entityReference ||
                selected.presentation.entityLabel
              }`
            : undefined
        }
        size="md"
      >
        {selected && (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                What happened
              </p>
              <p className="mt-1 break-words text-sm text-slate-800">
                {selected.presentation.description}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">
                Related record
              </h3>
              <DetailFields
                fields={[
                  {
                    label: "Type",
                    value: selected.presentation.entityLabel,
                  },
                  ...(selected.presentation.entityReference
                    ? [
                        {
                          label: "Reference",
                          value: selected.presentation.entityReference,
                        },
                      ]
                    : []),
                  ...(selected.presentation.entitySecondary
                    ? [
                        {
                          label: "Context",
                          value: selected.presentation.entitySecondary,
                        },
                      ]
                    : []),
                ]}
              />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-slate-900">
                Recorded details
              </h3>
              <DetailFields fields={selected.presentation.detailFields} />
            </div>

            {selected.presentation.technicalDetails.length > 0 && (
              <details className="rounded-xl border border-slate-200 bg-white p-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">
                  Technical details (administrators)
                </summary>
                <p className="mt-1 text-xs text-slate-500">
                  Secondary metadata for support and auditing. Passwords, tokens and
                  secrets are never shown.
                </p>
                <div className="mt-3">
                  <DetailFields fields={selected.presentation.technicalDetails} />
                </div>
              </details>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
