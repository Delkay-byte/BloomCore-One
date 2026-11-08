"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useFormDraft } from "@/hooks/useFormDraft";
import DraftIndicator from "@/components/DraftIndicator";

import { Footprints, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import {
  getCollectors,
  createCollector,
  toggleCollectorStatus,
  resetCollectorPassword,
  setMomoCapability,
} from "@/lib/actions/susu-collector.actions";
import { getActiveLocations } from "@/lib/actions/location.actions";
import PasswordInput from "@/components/PasswordInput";
import ReauthDialog from "@/components/ReauthDialog";
import CediAmount from "@/components/CediAmount";

interface CollectorData {
  id: string;
  status: string;
  user: { id: string; fullName: string; email: string; phone?: string | null; status: string; momoEnabled?: boolean };
  assignments: Array<{ id: string }>;
  contributions: Array<{ id: string; amount: number }>;
  remittances: Array<{ id: string; status: string; expectedAmount: number; remittedAmount: number }>;
}

interface LocationOption { id: string; name: string; code: string; }

export default function SusuCollectorsPage() {
  const handleRedirect = useRedirectHandler();
  const [collectors, setCollectors] = useState<CollectorData[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const createFormRef = useRef<HTMLFormElement>(null);
  const createDraft = useFormDraft(createFormRef, {
    draftKey: "susu-collector:new",
    workflow: "susu.collector.create",
    enabled: showForm,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [momoFor, setMomoFor] = useState<string | null>(null);
  const [showReauth, setShowReauth] = useState(false);
  const [pendingReset, setPendingReset] = useState<{ collectorId: string; formData: FormData } | null>(null);

  useEffect(() => {
    loadCollectors();
  }, []);

  async function loadCollectors() {
    try {
      const [data, locs] = await Promise.all([getCollectors(), getActiveLocations().catch(() => [])]);
      setCollectors(data as unknown as CollectorData[]);
      setLocations(locs as unknown as LocationOption[]);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load collectors")) return;
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(formData: FormData) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await createCollector(formData);
      if (result.success) {
        setSuccess("Temporary password created — the collector must change it after first login.");
        setShowForm(false);
        await createDraft.clearDraft();
        loadCollectors();
      } else {
        setError(result.error || "Failed to create collector");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
    }
  }

  function handleResetPassword(collectorId: string, formData: FormData) {
    setPendingReset({ collectorId, formData });
    setShowReauth(true);
  }

  async function executeResetPassword() {
    if (!pendingReset) return;
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await resetCollectorPassword(pendingReset.collectorId, pendingReset.formData);
      if (result.success) {
        setSuccess("Temporary password created. The user must change this password after first login — existing sessions were signed out.");
        setResetFor(null);
      } else {
        setError(result.error || "Failed to reset password");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
      setShowReauth(false);
      setPendingReset(null);
    }
  }

  async function handleMomoToggle(userId: string, enabled: boolean, locationId?: string) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await setMomoCapability(userId, enabled, locationId);
      if (result.success) {
        setSuccess(enabled ? "MoMo module enabled for this account." : "MoMo module disabled for this account.");
        setMomoFor(null);
        loadCollectors();
      } else {
        setError(result.error || "Failed to update MoMo capability");
      }
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <SkeletonPage variant="table" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Collectors</h1>
          <p className="text-slate-500 mt-1">Manage field collectors</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ New Collector"}
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

      <ReauthDialog
        open={showReauth}
        onClose={() => { setShowReauth(false); setPendingReset(null); }}
        onConfirmed={executeResetPassword}
        title="Confirm your identity"
        description="For your security, enter your password before resetting this collector's password."
        actionLabel="Reset Password"
      />

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Register New Collector</h2>
          <form ref={createFormRef} action={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input type="text" name="fullName" autoComplete="name" placeholder="Collector name" required />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input type="email" name="email" autoComplete="email" placeholder="collector@example.com" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input type="tel" name="phone" autoComplete="tel" placeholder="+233 XX XXX XXXX" />
              </div>
              <div className="form-group">
                <label className="form-label">Temporary Password *</label>
                <PasswordInput name="password" placeholder="Min 8 chars" required autoComplete="new-password" />
                <p className="form-hint">Temporary password created — the user must change this password after first login.</p>
              </div>
            </div>
<div className="mb-3">
              <DraftIndicator
                status={createDraft.status}
                lastSavedAt={createDraft.lastSavedAt}
                onDiscard={createDraft.clearDraft}
                onAcknowledge={createDraft.acknowledgeRestored}
              onRetry={createDraft.retry}
              />
            </div>
                        <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Creating..." : "Create Collector"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {collectors.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><Footprints size={36} /></p>
            <p className="font-medium">No collectors yet</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Collector</th>
                  <th>Customers</th>
                  <th>Today&apos;s Collections</th>
                  <th>Last Remittance</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {collectors.map((c) => {
                  const todayCollected = c.contributions.reduce((sum, col) => sum + Number(col.amount), 0);
                  const lastRemittance = c.remittances[0];
                  return (
                    <Fragment key={c.id}>
                      <tr>
                      <td>
                        <div className="font-medium">{c.user.fullName}</div>
                        <div className="text-xs text-slate-500">{c.user.email}</div>
                        {c.user.phone && <div className="text-xs text-slate-400">{c.user.phone}</div>}
                      </td>
                      <td>{c.assignments.length}</td>
                      <td className="font-mono text-sm">
                        {todayCollected > 0 ? <CediAmount amount={todayCollected} /> : "—"}
                      </td>
                      <td>
                        {lastRemittance ? (
                          <span className={`badge ${lastRemittance.status === "reconciled" ? "badge-green" : "badge-red"}`}>
                            {lastRemittance.status}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-sm">None</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${c.user.status === "active" ? "badge-green" : "badge-red"}`}>
                          {c.user.status}
                        </span>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={async () => {
                              const newStatus = c.user.status === "active" ? "inactive" : "active";
                              await toggleCollectorStatus(c.id, newStatus);
                              loadCollectors();
                            }}
                            className={`text-sm ${
                              c.user.status === "active"
                                ? "text-red-600 hover:text-red-800"
                                : "text-green-600 hover:text-green-800"
                            }`}
                          >
                            {c.user.status === "active" ? "Deactivate" : "Activate"}
                          </button>
                          <button
                            onClick={() => { setResetFor(resetFor === c.id ? null : c.id); setMomoFor(null); }}
                            className="text-sm text-yellow-700 hover:text-yellow-800"
                          >
                            Reset Password
                          </button>
                          <button
                            onClick={() => { setMomoFor(momoFor === c.id ? null : c.id); setResetFor(null); }}
                            className="text-sm text-blue-600 hover:text-blue-800"
                          >
                            {c.user.momoEnabled ? "MoMo: On" : "+ MoMo"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {resetFor === c.id && (
                      <tr key={`${c.id}-reset`}>
                        <td colSpan={6} className="bg-yellow-50">
                          <form action={(fd) => handleResetPassword(c.id, fd)} className="flex flex-wrap items-end gap-3 p-2">
                            <div className="w-64">
                              <label className="form-label">New Temporary Password</label>
                              <PasswordInput name="newPassword" placeholder="Min 8 chars" required autoComplete="new-password" />
                            </div>
                            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>Reset</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setResetFor(null)}>Cancel</button>
                            <p className="text-xs text-slate-500 w-full">The collector must change this password after first login.</p>
                          </form>
                        </td>
                      </tr>
                    )}
                    {momoFor === c.id && (
                      <tr key={`${c.id}-momo`}>
                        <td colSpan={6} className="bg-blue-50">
                          <div className="flex flex-wrap items-end gap-3 p-2">
                            <div className="w-64">
                              <label className="form-label">Assigned MoMo Location</label>
                              <select id={`momo-loc-${c.id}`} className="w-full" defaultValue="">
                                <option value="">Select a location</option>
                                {locations.map((loc) => (
                                  <option key={loc.id} value={loc.id}>{loc.name} ({loc.code})</option>
                                ))}
                              </select>
                            </div>
                            {c.user.momoEnabled ? (
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={submitting}
                                onClick={() => handleMomoToggle(c.user.id, false)}
                              >
                                Disable MoMo
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={submitting}
                                onClick={() => {
                                  const select = document.getElementById(`momo-loc-${c.id}`) as HTMLSelectElement | null;
                                  handleMomoToggle(c.user.id, true, select?.value || undefined);
                                }}
                              >
                                Enable MoMo
                              </button>
                            )}
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMomoFor(null)}>Cancel</button>
                            <p className="text-xs text-slate-500 w-full">Same account, same login — this only adds or removes the MoMo module for this person.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
