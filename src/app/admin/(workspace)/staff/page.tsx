"use client";
import { useOptimisticAction } from "@/hooks/useOptimisticAction";
import { useToast } from "@/components/ui/Toast";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useFormDraft } from "@/hooks/useFormDraft";
import DraftIndicator from "@/components/DraftIndicator";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getStaff, createStaff, toggleStaffStatus } from "@/lib/actions/staff.actions";
import { formatDate } from "@/lib/utils";
import PasswordInput from "@/components/PasswordInput";

interface StaffMember {
  id: string;
  fullName: string;
  email: string;
  phone?: string | null;
  role: string;
  status: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  createdAt: Date;
  location?: { id: string; name: string; code: string } | null;
  collector?: { id: string; status: string } | null;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  worker: "Office Staff",
  collector: "Susu Collector",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-100 text-purple-800",
  worker: "bg-blue-100 text-blue-800",
  collector: "bg-green-100 text-green-800",
};

export default function StaffPage() {
  const handleRedirect = useRedirectHandler();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const createFormRef = useRef<HTMLFormElement>(null);
  const createDraft = useFormDraft(createFormRef, {
    draftKey: "admin-staff:new",
    workflow: "admin.staff.create",
    enabled: showForm,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const toast = useToast();
  const optimistic = useOptimisticAction();

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const data = await getStaff();
      setStaff(data as unknown as StaffMember[]);
    } catch (err) {
      if (handleRedirect(err, setError, "Failed to load staff")) return;
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(formData: FormData) {
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const result = await createStaff(formData);
      if (result.success) {
        setSuccess("Staff member created. Share the temporary password securely — they must change it on first login.");
        setShowForm(false);
        await createDraft.clearDraft();
        loadData();
      } else {
        setError(result.error || "Failed to create staff member");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(staffId: string, currentStatus: string) {
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    const flip = (status: string) =>
      setStaff((list) =>
        list.map((member) => (member.id === staffId ? { ...member, status } : member))
      );
    // Safe, reversible change: the row updates immediately and rolls back if
    // the server refuses it.
    await optimistic.run({
      apply: () => flip(newStatus),
      rollback: () => flip(currentStatus),
      action: () => toggleStaffStatus(staffId, newStatus),
      onSuccess: () => toast.push("success", "Staff status updated."),
      onError: (message) => {
        setError(message);
        toast.push("error", message);
      },
    });
  }

  const filtered = staff.filter((s) => {
    if (filter === "active" && s.status !== "active") return false;
    if (filter === "inactive" && s.status !== "inactive") return false;
    if (filter === "admin" && s.role !== "admin") return false;
    if (filter === "worker" && s.role !== "worker") return false;
    if (filter === "collector" && s.role !== "collector") return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.fullName.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        (s.phone || "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    }
    return true;
  });

  if (loading) return <SkeletonPage variant="table" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Staff Directory</h1>
          <p className="text-slate-500 mt-1">Manage office staff, collectors, and administrators</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn btn-primary"
        >
          {showForm ? "Cancel" : "+ Add Staff"}
        </button>
      </div>

      {error && (
        <div role="alert" className="banner banner-error mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700"><X size={14} aria-hidden /></button>
        </div>
      )}
      {success && (
        <div role="status" className="banner banner-success mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2 text-green-500 hover:text-green-700"><X size={14} aria-hidden /></button>
        </div>
      )}

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Add Staff Member</h2>
          <form ref={createFormRef} action={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input type="text" name="fullName" autoComplete="name" placeholder="Enter full name" required />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input type="email" name="email" autoComplete="email" placeholder="staff@example.com" required />
              </div>
              <div className="form-group">
                <label className="form-label">Phone</label>
                <input type="tel" name="phone" autoComplete="tel" placeholder="+233 XX XXX XXXX" />
              </div>
              <div className="form-group">
                <label className="form-label">Temporary Password *</label>
                <PasswordInput
                  name="password"
                  placeholder="Min 8 chars, 1 uppercase, 1 number"
                  required
                  autoComplete="new-password"
                />
                <p className="form-hint">User must change this password after first login.</p>
              </div>
              <div className="form-group">
                <label className="form-label">Role *</label>
                <select name="role" required defaultValue="worker">
                  <option value="worker">Office Staff</option>
                  <option value="collector">Susu Collector</option>
                </select>
                <p className="form-hint">Office Staff can receive and record payments. Collectors can also collect from customers.</p>
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select name="status" defaultValue="active">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
<div className="mb-3">
              <DraftIndicator
                status={createDraft.status}
                lastSavedAt={createDraft.lastSavedAt}
                onDiscard={createDraft.clearDraft}
                onAcknowledge={createDraft.acknowledgeRestored}
              />
            </div>
                        <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Creating..." : "Create Staff Member"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card mb-6">
        <div className="flex flex-wrap gap-2 mb-4">
          {[
            { key: "all", label: "All" },
            { key: "active", label: "Active" },
            { key: "inactive", label: "Inactive" },
            { key: "admin", label: "Admins" },
            { key: "worker", label: "Office Staff" },
            { key: "collector", label: "Collectors" },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`btn btn-sm ${filter === f.key ? "btn-primary" : "btn-secondary"}`}
            >
              {f.label}
            </button>
          ))}
          <div className="ml-auto">
            <input
              type="text"
              placeholder="Search name, email, phone, ID..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-green-400"
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2">👤</p>
            <p className="font-medium">No staff found</p>
            <p className="text-sm mt-1">
              {filter === "all" && !search
                ? "Create your first staff member to get started."
                : "No staff match the current filters."}
            </p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Contact</th>
                  <th>Modules</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="font-medium">{s.fullName}</div>
                      <div className="text-xs text-slate-400 font-mono">{s.id.slice(0, 12)}…</div>
                    </td>
                    <td>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[s.role] || "bg-slate-100 text-slate-800"}`}>
                        {ROLE_LABELS[s.role] || s.role}
                      </span>
                    </td>
                    <td>
                      <div className="text-sm">{s.email}</div>
                      {s.phone && <div className="text-xs text-slate-500">{s.phone}</div>}
                    </td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {s.momoEnabled && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                            MoMo
                          </span>
                        )}
                        {s.susuEnabled && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                            Susu
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${s.status === "active" ? "badge-green" : "badge-red"}`}>
                        {s.status === "active" ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="text-sm text-slate-500">{formatDate(s.createdAt)}</td>
                    <td>
                      <div className="flex gap-2">
                        <a
                          href={`/admin/staff/${s.id}`}
                          className="text-sm text-blue-600 hover:text-blue-800"
                        >
                          View
                        </a>
                        <button
                          onClick={() => handleToggleStatus(s.id, s.status)}
                          className={`text-sm ${s.status === "active" ? "text-red-600 hover:text-red-800" : "text-green-600 hover:text-green-800"}`}
                        >
                          {s.status === "active" ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
