"use client";
import { useOptimisticAction } from "@/hooks/useOptimisticAction";
import { useToast } from "@/components/ui/Toast";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useFormDraft } from "@/hooks/useFormDraft";
import DraftIndicator from "@/components/DraftIndicator";
import { X } from "lucide-react";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useRef, useState } from "react";
import { getLocations, createLocation, toggleLocationStatus } from "@/lib/actions/location.actions";
import { locationSchema } from "@/lib/validations";

interface Location {
  id: string; name: string; code: string; description?: string | null; address?: string | null;
  contactPhone?: string | null; status: string; createdAt: Date;
  _count: { users: number; dailyAccounts: number };
}

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const createFormRef = useRef<HTMLFormElement>(null);
  const createDraft = useFormDraft(createFormRef, {
    draftKey: "admin-location:new",
    workflow: "admin.location.create",
    enabled: showForm,
  });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState("all");
  const handleRedirect = useRedirectHandler();
  const toast = useToast();
  const optimistic = useOptimisticAction();

  useEffect(() => { loadLocations(); }, []);

  async function loadLocations() {
    try { const data = await getLocations(); setLocations(data as unknown as Location[]); }
    catch { setError("Failed to load locations"); }
    finally { setLoading(false); }
  }

  async function handleCreate(formData: FormData) {
    setSubmitting(true); setError(""); setSuccess(""); setFormErrors({});

    const raw = {
      name: (formData.get("name") as string)?.trim(),
      code: (formData.get("code") as string)?.trim().toUpperCase(),
      description: (formData.get("description") as string)?.trim() || undefined,
      address: (formData.get("address") as string)?.trim() || undefined,
      contactPhone: (formData.get("contactPhone") as string)?.trim() || undefined,
      status: "active",
    };const validated = locationSchema.safeParse(raw);
      if (!validated.success) {
        const errors: Record<string, string> = {};
        (validated.error.issues as Array<{ path: Array<string | number>; message: string }>).forEach((e) => { if (e.path[0]) errors[e.path[0] as string] = e.message; });
      setFormErrors(errors); setSubmitting(false); return;
    }

    try {
      const result = await createLocation(formData);
      if (result.success) { setSuccess("Location created successfully"); setShowForm(false); await createDraft.clearDraft(); loadLocations(); }
      else setError(result.error || "Failed to create location");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; }
    finally { setSubmitting(false); }
  }

  async function handleToggleStatus(locationId: string, currentStatus: string) {
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    const flip = (status: string) =>
      setLocations((list) =>
        list.map((location) => (location.id === locationId ? { ...location, status } : location))
      );
    await optimistic.run({
      apply: () => flip(newStatus),
      rollback: () => flip(currentStatus),
      action: () => toggleLocationStatus(locationId, newStatus),
      onSuccess: () => toast.push("success", "Location status updated."),
      onError: (message) => {
        setError(message);
        toast.push("error", message);
      },
    });
  }

  const filteredLocations = locations.filter((loc) => {
    if (filter === "active") return loc.status === "active";
    if (filter === "inactive") return loc.status === "inactive";
    return true;
  });

  if (loading) return <SkeletonPage variant="table" />;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Locations</h1>
          <p className="text-slate-500 mt-1">Manage your business locations</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? "Cancel" : "+ Add Location"}
        </button>
      </div>

      {error && <div role="alert" className="banner banner-error mb-4">{error}<button onClick={() => setError("")} className="ml-2 text-red-500 hover:text-red-700"><X size={14} aria-hidden /></button></div>}
      {success && <div role="status" className="banner banner-success mb-4">{success}<button onClick={() => setSuccess("")} className="ml-2 text-green-500 hover:text-green-700"><X size={14} aria-hidden /></button></div>}

      {showForm && (
        <div className="card mb-6">
          <h2 className="text-lg font-semibold mb-4">Create New Location</h2>
          <form ref={createFormRef} action={handleCreate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group">
                <label className="form-label">Location Name *</label>
                <input type="text" name="name" autoComplete="organization" placeholder="e.g. BIK Prestige - Accra Central" required />
                {formErrors.name && <p className="error-text">{formErrors.name}</p>}
              </div>
              <div className="form-group">
                <label className="form-label">Location Code *</label>
                <input type="text" name="code" autoComplete="off" placeholder="e.g. ACC-001" required />
                {formErrors.code && <p className="error-text">{formErrors.code}</p>}
                <p className="form-hint">Unique code. Letters, numbers, hyphens only.</p>
              </div>
              <div className="form-group">
                <label className="form-label">Address</label>
                <input type="text" name="address" autoComplete="street-address" placeholder="Street address" />
              </div>
              <div className="form-group">
                <label className="form-label">Contact Phone</label>
                <input type="tel" name="contactPhone" autoComplete="tel" placeholder="+233 XX XXX XXXX" />
              </div>
              <div className="form-group md:col-span-2">
                <label className="form-label">Description</label>
                <textarea id="description" name="description" rows={2} placeholder="Brief description" />
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
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Creating..." : "Create Location"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {["all", "active", "inactive"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`btn btn-sm ${filter === f ? "btn-primary" : "btn-secondary"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="card">
        {filteredLocations.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <p className="text-4xl mb-2">📍</p>
            <p className="font-medium">No locations found</p>
            <p className="text-sm mt-1">{filter === "all" ? "Create your first location to get started." : `No ${filter} locations.`}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead><tr><th>Name</th><th>Code</th><th>Workers</th><th>Reports</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {filteredLocations.map((loc) => (
                  <tr key={loc.id}>
                    <td>
                      <div className="font-medium">{loc.name}</div>
                      {loc.address && <div className="text-xs text-slate-500">{loc.address}</div>}
                    </td>
                    <td className="font-mono text-sm">{loc.code}</td>
                    <td>{loc._count.users}</td>
                    <td>{loc._count.dailyAccounts}</td>
                    <td><span className={`badge ${loc.status === "active" ? "badge-green" : "badge-red"}`}>{loc.status === "active" ? "Active" : "Inactive"}</span></td>
                    <td>
                      <div className="flex gap-2">
                        <a href={`/admin/locations/${loc.id}`} className="text-sm text-blue-600 hover:text-blue-800">View</a>
                        <button onClick={() => handleToggleStatus(loc.id, loc.status)} className={`text-sm ${loc.status === "active" ? "text-red-600 hover:text-red-800" : "text-green-600 hover:text-green-800"}`}>
                          {loc.status === "active" ? "Deactivate" : "Activate"}
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
