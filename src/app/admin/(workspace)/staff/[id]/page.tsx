"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getStaffById, updateStaff, resetStaffPassword, toggleStaffStatus } from "@/lib/actions/staff.actions";
import { formatDateTime } from "@/lib/utils";
import PasswordInput from "@/components/PasswordInput";

interface StaffDetail {
  id: string;
  fullName: string;
  email: string;
  phone?: string | null;
  role: string;
  status: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  forcePasswordReset: boolean;
  createdAt: Date;
  updatedAt: Date;
  location?: { id: string; name: string; code: string } | null;
  collector?: { id: string; status: string } | null;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  worker: "Office Staff",
  collector: "Susu Collector",
};

export default function StaffDetailPage() {
  const params = useParams();
  const staffId = params.id as string;
  const handleRedirect = useRedirectHandler();

  const [staff, setStaff] = useState<StaffDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);

  useEffect(() => { loadStaff(); }, [staffId]);

  async function loadStaff() {
    try {
      const data = await getStaffById(staffId);
      if (!data) {
        setError("Staff member not found");
        return;
      }
      setStaff(data as unknown as StaffDetail);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load staff")) return;
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdate(formData: FormData) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await updateStaff(staffId, formData);
      if (result.success) {
        setSuccess("Staff member updated.");
        setShowEdit(false);
        loadStaff();
      } else {
        setError(result.error || "Failed to update staff");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasswordReset(formData: FormData) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await resetStaffPassword(staffId, formData);
      if (result.success) {
        setSuccess("Password reset. Existing sessions invalidated. Share the new password securely.");
        setShowPasswordReset(false);
        loadStaff();
      } else {
        setError(result.error || "Failed to reset password");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus() {
    if (!staff) return;
    const newStatus = staff.status === "active" ? "inactive" : "active";
    try {
      const result = await toggleStaffStatus(staffId, newStatus);
      if (result.success) loadStaff();
      else setError(result.error || "Failed to update status");
    } catch {
      setError("An unexpected error occurred");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!staff) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Staff member not found.</p>
        <Link href="/admin/staff" className="text-brand-700 hover:underline mt-2 inline-block">
          ← Back to Staff Directory
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <Link href="/admin/staff" className="text-sm text-brand-700 hover:underline">← Staff Directory</Link>
          <h1 className="text-2xl font-bold text-slate-900 mt-2">{staff.fullName}</h1>
          <p className="text-slate-500 mt-1">{ROLE_LABELS[staff.role] || staff.role}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowEdit(!showEdit); setShowPasswordReset(false); setError(""); setSuccess(""); }}
            className="btn btn-secondary btn-sm"
          >
            {showEdit ? "Cancel Edit" : "Edit"}
          </button>
          <button
            onClick={() => { setShowPasswordReset(!showPasswordReset); setShowEdit(false); setError(""); setSuccess(""); }}
            className="btn btn-secondary btn-sm"
          >
            {showPasswordReset ? "Cancel" : "Reset Password"}
          </button>
          <button
            onClick={handleToggleStatus}
            className={`btn btn-sm ${staff.status === "active" ? "btn-danger" : "btn-primary"}`}
          >
            {staff.status === "active" ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>

      {error && (
        <div className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700"><X size={14} aria-hidden /></button>
        </div>
      )}
      {success && (
        <div className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 text-green-500 hover:text-green-700"><X size={14} aria-hidden /></button>
        </div>
      )}

      {/* Edit Form */}
      {showEdit && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Edit Staff Member</h2>
          <form action={handleUpdate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input type="text" name="fullName" defaultValue={staff.fullName} required />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input type="email" name="email" defaultValue={staff.email} required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input type="tel" name="phone" defaultValue={staff.phone || ""} />
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select name="status" defaultValue={staff.status}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Saving..." : "Save Changes"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowEdit(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Password Reset */}
      {showPasswordReset && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Reset Password</h2>
          <form action={handlePasswordReset}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">New Password *</label>
                <PasswordInput
                  name="newPassword"
                  placeholder="Min 8 chars, 1 uppercase, 1 number"
                  required
                  autoComplete="new-password"
                />
                <p className="form-hint">User must change this password after first login. Existing sessions will be invalidated.</p>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Resetting..." : "Reset Password"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowPasswordReset(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Staff Info Card */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Staff Information</h3>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-slate-500">Full Name</dt>
              <dd className="font-medium">{staff.fullName}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Staff ID</dt>
              <dd className="font-mono text-sm">{staff.id}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Email</dt>
              <dd>{staff.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Phone</dt>
              <dd>{staff.phone || "—"}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Role</dt>
              <dd>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  staff.role === "admin" ? "bg-purple-100 text-purple-800" :
                  staff.role === "collector" ? "bg-green-100 text-green-800" :
                  "bg-blue-100 text-blue-800"
                }`}>
                  {ROLE_LABELS[staff.role] || staff.role}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Status</dt>
              <dd>
                <span className={`badge ${staff.status === "active" ? "badge-green" : "badge-red"}`}>
                  {staff.status === "active" ? "Active" : "Inactive"}
                </span>
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Modules & Capabilities</h3>
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-slate-500">MoMo Module</dt>
              <dd>{staff.momoEnabled ? "✅ Enabled" : "❌ Disabled"}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Susu Module</dt>
              <dd>{staff.susuEnabled ? "✅ Enabled" : "❌ Disabled"}</dd>
            </div>
            {staff.collector && (
              <div>
                <dt className="text-sm text-slate-500">Collector Status</dt>
                <dd>
                  <span className={`badge ${staff.collector.status === "active" ? "badge-green" : "badge-red"}`}>
                    {staff.collector.status === "active" ? "Active" : "Inactive"}
                  </span>
                </dd>
              </div>
            )}
            {staff.location && (
              <div>
                <dt className="text-sm text-slate-500">Location</dt>
                <dd>{staff.location.name} ({staff.location.code})</dd>
              </div>
            )}
            <div>
              <dt className="text-sm text-slate-500">Force Password Reset</dt>
              <dd>{staff.forcePasswordReset ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Created</dt>
              <dd>{formatDateTime(staff.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-sm text-slate-500">Last Updated</dt>
              <dd>{formatDateTime(staff.updatedAt)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
