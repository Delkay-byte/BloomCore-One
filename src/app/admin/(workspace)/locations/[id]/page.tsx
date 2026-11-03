"use client";
import { SkeletonPage } from "@/components/ui/Skeletons";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getLocationById, updateLocation, toggleLocationStatus } from "@/lib/actions/location.actions";

interface LocationDetail {
  id: string; name: string; code: string; description?: string | null; address?: string | null;
  contactPhone?: string | null; status: string; createdAt: Date; updatedAt: Date;
  users: Array<{ id: string; fullName: string; email: string; role: string; status: string }>;
}

export default function LocationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [location, setLocation] = useState<LocationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const handleRedirect = useRedirectHandler();

  useEffect(() => { loadLocation(); }, [params.id]);

  async function loadLocation() {
    try { const data = await getLocationById(params.id as string); setLocation(data as unknown as LocationDetail); }
    catch { setError("Failed to load location"); }
    finally { setLoading(false); }
  }

  async function handleUpdate(formData: FormData) {
    setSubmitting(true); setError(""); setSuccess("");
    try {
      const result = await updateLocation(params.id as string, formData);
      if (result.success) { setSuccess("Location updated successfully"); setEditing(false); loadLocation(); }
      else setError(result.error || "Failed to update location");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; }
    finally { setSubmitting(false); }
  }

  async function handleToggleStatus() {
    if (!location) return;
    const newStatus = location.status === "active" ? "inactive" : "active";
    try {
      const result = await toggleLocationStatus(location.id, newStatus);
      if (result.success) loadLocation();
      else setError(result.error || "Failed to update status");
    } catch (err) { if (handleRedirect(err, setError, "An unexpected error occurred")) return; }
  }

  if (loading) return <SkeletonPage variant="detail" />;
  if (!location) return <div className="text-center py-20"><p className="text-slate-500">Location not found</p><button onClick={() => router.push("/admin/locations")} className="btn btn-primary mt-4">Back to Locations</button></div>;

  return (
    <div>
      <div className="mb-8">
        <button onClick={() => router.push("/admin/locations")} className="text-sm text-slate-500 hover:text-slate-700 mb-2 inline-block">← Back to Locations</button>
        <div className="flex items-center justify-between">
          <div><h1 className="text-2xl font-bold text-slate-900">{location.name}</h1><p className="text-slate-500 mt-1">Code: {location.code}</p></div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(!editing)} className="btn btn-secondary btn-sm">{editing ? "Cancel" : "Edit"}</button>
            <button onClick={handleToggleStatus} className={`btn btn-sm ${location.status === "active" ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-green-100 text-green-700 hover:bg-green-200"}`}>
              {location.status === "active" ? "Deactivate" : "Activate"}
            </button>
          </div>
        </div>
      </div>

      {error && <div role="alert" className="banner banner-error mb-4">{error}</div>}
      {success && <div role="status" className="banner banner-success mb-4">{success}</div>}

      {editing ? (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Edit Location</h2>
          <form action={handleUpdate}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="form-group"><label className="form-label">Location Name *</label><input type="text" name="name" autoComplete="organization" defaultValue={location.name} required /></div>
              <div className="form-group"><label className="form-label">Location Code *</label><input type="text" name="code" defaultValue={location.code} required /></div>
              <div className="form-group"><label className="form-label">Address</label><input type="text" name="address" autoComplete="street-address" defaultValue={location.address || ""} /></div>
              <div className="form-group"><label className="form-label">Contact Phone</label><input type="tel" name="contactPhone" autoComplete="tel" defaultValue={location.contactPhone || ""} /></div>
              <div className="form-group md:col-span-2"><label className="form-label">Description</label><textarea name="description" rows={2} defaultValue={location.description || ""} /></div>
              <div className="form-group"><label className="form-label">Status</label><select name="status" defaultValue={location.status}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
            </div>
            <div className="flex gap-3 mt-4">
              <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Saving..." : "Save Changes"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="font-semibold mb-3">Location Details</h3>
            <dl className="space-y-2">
              <div><dt className="text-sm text-slate-500">Status</dt><dd><span className={`badge ${location.status === "active" ? "badge-green" : "badge-red"}`}>{location.status === "active" ? "Active" : "Inactive"}</span></dd></div>
              {location.address && <div><dt className="text-sm text-slate-500">Address</dt><dd>{location.address}</dd></div>}
              {location.contactPhone && <div><dt className="text-sm text-slate-500">Contact</dt><dd>{location.contactPhone}</dd></div>}
              {location.description && <div><dt className="text-sm text-slate-500">Description</dt><dd>{location.description}</dd></div>}
            </dl>
          </div>
          <div className="card">
            <h3 className="font-semibold mb-3">Assigned Workers</h3>
            {location.users.length === 0 ? (
              <p className="text-slate-500 text-sm">No workers assigned to this location yet.</p>
            ) : (
              <div className="space-y-2">
                {location.users.map((user) => (
                  <div key={user.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-50">
                    <div><div className="font-medium text-sm">{user.fullName}</div><div className="text-xs text-slate-500">{user.email}</div></div>
                    <span className={`badge ${user.status === "active" ? "badge-green" : "badge-red"}`}>{user.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
