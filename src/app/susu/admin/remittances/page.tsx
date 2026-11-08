"use client";
import { SkeletonTable } from "@/components/ui/Skeletons";

import { Landmark, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getRemittances,
  recordRemittance,
  reverseRemittance,
  getCollectors,
} from "@/lib/actions/susu-collector.actions";
import { formatCedi, formatDateTime } from "@/lib/utils";
import CediAmount from "@/components/CediAmount";
import { PromptDialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

interface RemittanceRecord {
  id: string;
  expectedAmount: number;
  remittedAmount: number;
  variance: number;
  status: string;
  notes?: string | null;
  reversedAt?: Date | null;
  reversalReason?: string | null;
  createdAt: Date;
  collector: { user: { fullName: string } };
}

interface CollectorOption {
  id: string;
  user: { fullName: string };
}

export default function SusuRemittancesPage() {
  const handleRedirect = useRedirectHandler();
  const [remittances, setRemittances] = useState<RemittanceRecord[]>([]);
  const [collectors, setCollectors] = useState<CollectorOption[]>([]);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);

  // Remittance form
  const [showForm, setShowForm] = useState(false);
  const [selectedCollector, setSelectedCollector] = useState("");
  const [remittedAmount, setRemittedAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<RemittanceRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState("");
  const toast = useToast();

  useEffect(() => {
    loadRemittances();
  }, [page]);

  useEffect(() => {
    loadCollectors();
  }, []);

  async function loadRemittances() {
    setLoading(true);
    try {
      const result = await getRemittances({ page, limit: 15 });
      setRemittances(result.remittances as unknown as RemittanceRecord[]);
      setPagination(result.pagination);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load remittances")) return;
    } finally {
      setLoading(false);
    }
  }

  async function loadCollectors() {
    try {
      const data = await getCollectors();
      setCollectors(data as unknown as CollectorOption[]);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load collectors")) return;
    }
  }

  async function handleRecordRemittance() {
    if (!selectedCollector) {
      setError("Please select a collector");
      return;
    }

    const amountNum = parseFloat(remittedAmount);
    if (!amountNum || amountNum < 0) {
      setError("Please enter a valid remittance amount");
      return;
    }

    setSubmitting(true);
    setError("");
    setSuccess("");

    try {
      const result = await recordRemittance({
        collectorId: selectedCollector,
        remittedAmount: amountNum,
        notes: notes || undefined,
      });

      if (result.success) {
        const data = result.data as { variance: number; expectedAmount: number };
        setSuccess(
          `Money handed in recorded. Expected: ${formatCedi(data.expectedAmount)}, Handed In: ${formatCedi(amountNum)}, Difference: ${formatCedi(data.variance)}`
        );
        setShowForm(false);
        setSelectedCollector("");
        setRemittedAmount("");
        setNotes("");
        loadRemittances();
      } else {
        setError(result.error || "Failed to record remittance");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
      setError("An unexpected error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  function handleReverse(record: RemittanceRecord) {
    setReverseTarget(record);
    setReverseReason("");
    setReverseError("");
  }

  async function submitReverse() {
    if (!reverseTarget || reverseBusy) return;
    if (reverseReason.trim().length < 10) {
      setReverseError("Enter a reversal reason of at least 10 characters.");
      return;
    }
    setReverseBusy(true);
    setReverseError("");
    try {
      const result = await reverseRemittance({
        remittanceId: reverseTarget.id,
        reason: reverseReason.trim(),
      });
      if (!result.success) {
        setReverseError(result.error || "The remittance could not be reversed.");
        return;
      }
      setSuccess("Remittance reversed. The original record remains in history.");
      toast.push("success", "Remittance reversed successfully.");
      setReverseTarget(null);
      setReverseReason("");
      await loadRemittances();
    } catch {
      setReverseError("The remittance could not be reversed. Please try again.");
    } finally {
      setReverseBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Collector Money Handed In</h1>
          <p className="text-slate-500 mt-1">Record and reconcile money collectors bring to the business</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Record Money Handed In"}
        </button>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2"><X size={14} aria-hidden /></button>
        </div>
      )}

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Record Money Handed In</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-group">
              <label className="form-label">Collector *</label>
              <select
                value={selectedCollector}
                onChange={(e) => setSelectedCollector(e.target.value)}
              >
                <option value="">Select collector</option>
                {collectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.user.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Amount Handed In (GH₵) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Amount brought to office"
                value={remittedAmount}
                onChange={(e) => setRemittedAmount(e.target.value)}
              />
            </div>
            <div className="form-group md:col-span-2">
              <label className="form-label">Notes</label>
              <input
                type="text"
                placeholder="Optional note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleRecordRemittance}
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? "Recording..." : "Record Remittance"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Remittances List */}
      <div className="card">
        {loading ? (
          <SkeletonTable rows={8} columns={6} />
        ) : remittances.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><Landmark size={36} /></p>
            <p className="font-medium">No money handed in yet</p>
          </div>
        ) : (
          <>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Collector</th>
                    <th>Expected to Bring In</th>
                    <th>Amount Handed In</th>
                    <th>Difference</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {remittances.map((r) => (
                    <tr key={r.id}>
                      <td className="text-sm">{formatDateTime(r.createdAt)}</td>
                      <td className="font-medium text-sm">{r.collector.user.fullName}</td>
                      <td className="font-mono text-sm"><CediAmount amount={r.expectedAmount} /></td>
                      <td className="font-mono text-sm font-semibold"><CediAmount amount={r.remittedAmount} /></td>
                      <td className="font-mono text-sm">
                        <span className={r.variance === 0 ? "text-green-600" : "text-red-600"}>
                          <CediAmount amount={r.variance} />
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            r.status === "reconciled"
                              ? "badge-green"
                              : r.status === "discrepancy"
                              ? "badge-red"
                              : "badge-yellow"
                          }`}
                        >
                          {r.status === "reconciled" ? "Matches" : r.status === "discrepancy" ? "Short" : r.status}
                        </span>
                      </td>
                      <td>
                        {r.reversedAt ? (
                          <span className="text-xs text-slate-500">Reversed</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleReverse(r)}
                            className="btn btn-secondary btn-sm"
                          >
                            Reverse
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200">
                <p className="text-sm text-slate-500">
                  Page {pagination.page} of {pagination.totalPages}
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
                    onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                    disabled={page === pagination.totalPages}
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

      <PromptDialog
        open={Boolean(reverseTarget)}
        onClose={() => {
          if (!reverseBusy) setReverseTarget(null);
        }}
        onSubmit={submitReverse}
        title="Reverse this remittance?"
        description="The original record is kept and removed from active cash-handover totals."
        label="Reason for reversal (minimum 10 characters)"
        placeholder="Explain what was wrong and what evidence supports the reversal."
        confirmLabel="Reverse remittance"
        required
        loading={reverseBusy}
        value={reverseReason}
        onChange={setReverseReason}
        error={reverseError}
        multiline
      />
    </div>
  );
}
