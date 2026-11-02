"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getWorkerById, updateWorker, resetWorkerPassword } from "@/lib/actions/worker.actions";
import { getActiveLocations } from "@/lib/actions/location.actions";
import PasswordInput from "@/components/PasswordInput";
import ReauthDialog from "@/components/ReauthDialog";
import CediAmount from "@/components/CediAmount";

interface WorkerDetail {
  id: string; fullName: string; email: string; phone?: string | null; role: string;
  status: string; forcePasswordReset: boolean; createdAt: Date;
  momoEnabled?: boolean; susuEnabled?: boolean;
  location?: { id: string; name: string; code: string } | null;
  dailyAccounts: Array<{
    id: string; businessDate: Date; status: string;
    calculatedMomoVariance: number; calculatedCashVariance: number;
    location: { name: string };
  }>;
}
interface Location { id: string; name: string; code: string; }

export default function WorkerDetailPage() {
  const handleRedirect = useRedirectHandler();
  const params = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingResetData, setPendingResetData] = useState<FormData | null>(null);
  const [showReauth, setShowReauth] = useState(false);

  useEffect(() => { loadData(); }, [params.id]);

  async function loadData() {
    try {
      const [workerData, locationsData] = await Promise.all([getWorkerById(params.id as string), getActiveLocations()]);
      setWorker(workerData as unknown as WorkerDetail); setLocations(locationsData as Location[]);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load worker data")) return; } finally { setLoading(false); }
  }

  async function handleUpdate(formData: FormData) {
    setSubmitting(true); setError(""); setSuccess("");
    try {
      const result = await updateWorker(params.id as string, formData);
      if (result.success) { setSuccess("Worker updated successfully"); setEditing(false); loadData(); }
      else setError(result.error || "Failed to update worker");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setSubmitting(false); }
  }

  function handleResetPassword(formData: FormData) {
    // Require reauthentication before password reset
    setPendingResetData(formData);
    setShowReauth(true);
  }

  async function executeResetPassword() {
    if (!pendingResetData) return;
    setSubmitting(true); setError(""); setSuccess("");
    try {
      const result = await resetWorkerPassword(params.id as string, pendingResetData);
      if (result.success) { setSuccess("Temporary password created. The user must change this password after first login — existing sessions were signed out."); setResettingPassword(false); loadData(); }
      else setError(result.error || "Failed to reset password");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setSubmitting(false); setShowReauth(false); setPendingResetData(null); }
  }

  if (loading) return <SkeletonPage variant="detail" />;
  if (!worker) return <div className="text-center py-20"><p className="text-slate-500">Worker not found</p><button onClick={() => router.push("/admin/workers")} className="btn btn-primary mt-4">Back to Workers</button></div>;

  return (
    <div>
      <div className="mb-8">
        <button onClick={() => router.push("/admin/workers")} className="text-sm text-slate-500 hover:text-slate-700 mb-2 inline-block">← Back to Workers</button>
        <div className="flex items-center justify-between">
          <div><h1 className="text-2xl font-bold text-slate-900">{worker.fullName}</h1><p className="text-slate-500 mt-1">{worker.email}</p></div>
          <div className="flex gap-2">
            <button onClick={() => { setEditing(!editing); setResettingPassword(false); }} className="btn btn-secondary btn-sm">{editing ? "Cancel" : "Edit"}</button>
            <button onClick={() => { setResettingPassword(!resettingPassword); setEditing(false); }} className="btn btn-sm bg-yellow-100 text-yellow-700 hover:bg-yellow-200">Reset Password</button>
          </div>
        </div>
      </div>

      {error && <div role="alert" className="banner banner-error mb-4">{error}</div>}
      {success && <div role="status" className="banner banner-success mb-4">{success}</div>}

      {editing && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Edit Worker</h2>
          <form action={handleUpdate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group"><label className="form-label">Full Name *</label><input type="text" name="fullName" autoComplete="name" defaultValue={worker.fullName} required /></div>
              <div className="form-group"><label className="form-label">Email *</label><input type="email" name="email" autoComplete="email" defaultValue={worker.email} required /></div>
              <div className="form-group"><label className="form-label">Phone</label><input type="tel" name="phone" autoComplete="tel" defaultValue={worker.phone || ""} /></div>
              <div className="form-group"><label className="form-label">Location *</label><select name="locationId" defaultValue={worker.location?.id || ""} required><option value="">Select a location</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name} ({loc.code})</option>)}</select></div>
              <div className="form-group"><label className="form-label">Status</label><select name="status" defaultValue={worker.status}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
              <div className="form-group md:col-span-2">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="susuCollector" defaultChecked={worker.susuEnabled} className="w-4 h-4" />
                  Also register this person as a Susu collector (dual-role, same account)
                </label>
                <p className="form-hint">One person, one login — module capabilities are assignments on the same account.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Saving..." : "Save Changes"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ReauthDialog
        open={showReauth}
        onClose={() => { setShowReauth(false); setPendingResetData(null); }}
        onConfirmed={executeResetPassword}
        title="Confirm your identity"
        description="For your security, enter your password before resetting this user's password."
        actionLabel="Reset Password"
      />

      {resettingPassword && (
        <div className="card mb-6 border-yellow-200">
          <h2 className="text-lg font-semibold mb-4">Reset Password</h2>
          <form action={handleResetPassword}>
            <div className="form-group"><label className="form-label">New Temporary Password *</label><PasswordInput name="newPassword" placeholder="Min 8 chars, 1 uppercase, 1 number" required autoComplete="new-password" /><p className="form-hint">Temporary password created — the user must change this password after first login.</p></div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Resetting..." : "Reset Password"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setResettingPassword(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="font-semibold mb-3">Worker Details</h3>
          <dl className="space-y-2">
            <div><dt className="text-sm text-slate-500">Status</dt><dd><span className={`badge ${worker.status === "active" ? "badge-green" : "badge-red"}`}>{worker.status === "active" ? "Active" : "Inactive"}</span></dd></div>
            {worker.location && <div><dt className="text-sm text-slate-500">Assigned Location</dt><dd>{worker.location.name} ({worker.location.code})</dd></div>}
            <div><dt className="text-sm text-slate-500">Created</dt><dd>{new Date(worker.createdAt).toLocaleDateString()}</dd></div>
            <div><dt className="text-sm text-slate-500">Modules</dt><dd className="text-sm">MoMo{worker.susuEnabled ? " · Susu (collector)" : ""}</dd></div>
            <div><dt className="text-sm text-slate-500">Force Password Reset</dt><dd>{worker.forcePasswordReset ? "Yes" : "No"}</dd></div>
          </dl>
        </div>
        <div className="card">
          <h3 className="font-semibold mb-3">Recent Reports</h3>
          {worker.dailyAccounts.length === 0 ? <p className="text-slate-500 text-sm">No reports submitted yet.</p> : (
            <div className="space-y-2">
              {worker.dailyAccounts.slice(0, 5).map((account) => {
                const variance = Number(account.calculatedMomoVariance) + Number(account.calculatedCashVariance);
                const statusLabel = account.status === "draft" ? "Draft Saved" : account.status === "submitted" ? "Submitted" : account.status === "reviewed" ? "Reviewed" : account.status;
                return (
                  <div key={account.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-50">
                    <div className="font-medium text-sm">{new Date(account.businessDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>
                    <div className="text-right">
                      <span className={`badge ${account.status === "submitted" ? "badge-green" : account.status === "reviewed" ? "badge-blue" : "badge-yellow"}`}>{statusLabel}</span>
                      {account.status !== "draft" && (
                        <div className="text-xs mt-1">
                          {variance === 0 ? (
                            <span className="text-green-600">✓ Matches</span>
                          ) : (
                            <span className="text-red-600">
                              Total Difference: <CediAmount amount={variance} />
                              <br />⚠ Check Required
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
