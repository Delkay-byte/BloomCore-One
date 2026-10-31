"use client";

import { Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { getWorkers, createWorker, toggleWorkerStatus } from "@/lib/actions/worker.actions";
import { getActiveLocations } from "@/lib/actions/location.actions";
import PasswordInput from "@/components/PasswordInput";

interface Worker {
  id: string; fullName: string; email: string; phone?: string | null; role: string;
  status: string; createdAt: Date;
  location?: { id: string; name: string; code: string } | null;
}
interface Location { id: string; name: string; code: string; }

export default function WorkersPage() {
  const handleRedirect = useRedirectHandler();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("all");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const [workersData, locationsData] = await Promise.all([getWorkers(), getActiveLocations()]);
      setWorkers(workersData as unknown as Worker[]); setLocations(locationsData as Location[]);
    } catch (err) { if (handleRedirect(err, setError, "Failed to load data")) return; } finally { setLoading(false); }
  }

  async function handleCreate(formData: FormData) {
    setSubmitting(true); setError(""); setSuccess("");
    try {
      const result = await createWorker(formData);
      if (result.success) { setSuccess("Temporary password created — the worker must change it after first login. Share these credentials securely."); setShowForm(false); loadData(); }
      else setError(result.error || "Failed to create worker");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; } finally { setSubmitting(false); }
  }

  async function handleToggleStatus(workerId: string, currentStatus: string) {
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    try { const result = await toggleWorkerStatus(workerId, newStatus); if (result.success) loadData(); else setError(result.error || "Failed to update worker"); }
    catch { setError("An unexpected error occurred"); }
  }

  const filteredWorkers = workers.filter((w) => {
    if (filter === "active") return w.status === "active";
    if (filter === "inactive") return w.status === "inactive";
    return true;
  });

  if (loading) return <div className="flex items-center justify-center py-20"><div className="spinner"></div></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div><h1 className="text-2xl font-bold text-slate-900">Workers</h1><p className="text-slate-500 mt-1">Manage your MoMo workers</p></div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">{showForm ? "Cancel" : "+ Add Worker"}</button>
      </div>

      {error && <div className="banner banner-error mb-4">{error}<button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700"><X size={14} aria-hidden /></button></div>}
      {success && <div className="banner banner-success mb-4">{success}<button onClick={() => setSuccess("")} className="ml-2 text-green-500 hover:text-green-700"><X size={14} aria-hidden /></button></div>}

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Create New Worker</h2>
          <form action={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group"><label className="form-label">Full Name *</label><input type="text" name="fullName" placeholder="Enter full name" required /></div>
              <div className="form-group"><label className="form-label">Email *</label><input type="email" name="email" placeholder="worker@example.com" required /></div>
              <div className="form-group"><label className="form-label">Phone</label><input type="tel" name="phone" placeholder="+233 XX XXX XXXX" /></div>
              <div className="form-group"><label className="form-label">Temporary Password *</label><PasswordInput name="password" placeholder="Min 8 chars, 1 uppercase, 1 number" required autoComplete="new-password" /><p className="form-hint">Temporary password created — the user must change this password after first login.</p></div>
              <div className="form-group"><label className="form-label">Assigned Location *</label><select name="locationId" required><option value="">Select a location</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name} ({loc.code})</option>)}</select></div>
              <div className="form-group"><label className="form-label">Status</label><select name="status" defaultValue="active"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Creating..." : "Create Worker"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {["all", "active", "inactive"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-secondary"}`}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
        ))}
      </div>

      <div className="card">
        {filteredWorkers.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2 [&>svg]:h-9 [&>svg]:w-9 flex justify-center text-brand-300" aria-hidden><Users size={36} /></p><p className="font-medium">No workers found</p>
            <p className="text-sm mt-1">{filter === "all" ? "Create your first worker to get started." : `No ${filter} workers.`}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Location</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {filteredWorkers.map((worker) => (
                  <tr key={worker.id}>
                    <td><div className="font-medium">{worker.fullName}</div>{worker.phone && <div className="text-xs text-slate-500">{worker.phone}</div>}</td>
                    <td className="text-sm text-slate-600">{worker.email}</td>
                    <td>{worker.location ? <span className="text-sm">{worker.location.name}<span className="text-slate-400 ml-1">({worker.location.code})</span></span> : <span className="text-sm text-slate-400">Unassigned</span>}</td>
                    <td><span className={`badge ${worker.status === "active" ? "badge-green" : "badge-red"}`}>{worker.status === "active" ? "Active" : "Inactive"}</span></td>
                    <td>
                      <div className="flex gap-2">
                        <a href={`/admin/workers/${worker.id}`} className="text-sm text-blue-600 hover:text-blue-800">View</a>
                        <button onClick={() => handleToggleStatus(worker.id, worker.status)} className={`text-sm ${worker.status === "active" ? "text-red-600 hover:text-red-800" : "text-green-600 hover:text-green-800"}`}>
                          {worker.status === "active" ? "Deactivate" : "Activate"}
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
