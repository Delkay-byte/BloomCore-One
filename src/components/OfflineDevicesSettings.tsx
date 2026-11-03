"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/utils";
import { isRedirectError } from "@/lib/errors";
import { SkeletonCardList } from "@/components/ui/Skeletons";

interface DeviceData {
  id: string;
  deviceId: string;
  deviceName: string | null;
  module: string;
  status: string;
  lastSyncAt: Date | null;
  createdAt: Date;
  user: { id: string; fullName: string; email: string; role: string };
}

export default function OfflineDevicesSettings() {
  const [devices, setDevices] = useState<DeviceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [actionPending, setActionPending] = useState<string | null>(null);

  async function loadDevices() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/devices");
      if (res.ok) {
        const data = await res.json();
        setDevices(data.devices || []);
      }
    } catch (err) {
      if (isRedirectError(err)) throw err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDevices();
  }, []);

  async function handleRevoke(deviceId: string) {
    if (!confirm("Revoke this device? It will no longer be allowed to synchronize offline financial transactions.")) return;
    setActionPending(deviceId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/admin/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, action: "revoke" }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess("Device revoked. It can no longer synchronize offline collections.");
        loadDevices();
      } else {
        setError(data.error || "Failed to revoke device");
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setActionPending(null);
    }
  }

  async function handleActivate(deviceId: string) {
    setActionPending(deviceId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/admin/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, action: "activate" }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess("Device reactivated");
        loadDevices();
      } else {
        setError(data.error || "Failed to activate device");
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Offline Devices</h2>
        <p className="text-sm text-gray-500 mt-1">
          Manage phones authorized to save Susu collections when there is no internet connection.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
          {error}
          <button onClick={() => setError("")} className="ml-2">✕</button>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg mb-4">
          {success}
          <button onClick={() => setSuccess("")} className="ml-2">✕</button>
        </div>
      )}

      {loading ? (
        <SkeletonCardList items={3} />
      ) : devices.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-4xl mb-2">📱</p>
          <p className="font-medium">No offline devices yet</p>
          <p className="text-sm mt-1">A collector&apos;s authorized phone will appear here after it is enrolled for offline collection.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {devices.map((device) => (
            <div key={device.id} className="border border-gray-200 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900">{device.user.fullName}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    device.status === "active" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    {device.status === "active" ? "Active" : device.status === "revoked" ? "Revoked" : "Expired"}
                  </span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    device.module === "susu" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                  }`}>
                    {device.module === "susu" ? "Susu" : "MoMo"}
                  </span>
                </div>
                <div className="text-sm text-gray-500 mt-1">
                  {device.user.email} · Device: {device.deviceId.substring(0, 12)}...
                  {device.deviceName && ` (${device.deviceName})`}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  Enrolled: {formatDateTime(device.createdAt)}
                  {device.lastSyncAt && ` · Last sync: ${formatDateTime(device.lastSyncAt)}`}
                </div>
              </div>
              <div className="flex-shrink-0">
                {device.status === "active" ? (
                  <button
                    onClick={() => handleRevoke(device.deviceId)}
                    disabled={actionPending === device.deviceId}
                    className="text-sm text-red-600 hover:text-red-800 font-medium"
                  >
                    {actionPending === device.deviceId ? "Revoking..." : "Revoke Device"}
                  </button>
                ) : (
                  <button
                    onClick={() => handleActivate(device.deviceId)}
                    disabled={actionPending === device.deviceId}
                    className="text-sm text-green-600 hover:text-green-800 font-medium"
                  >
                    {actionPending === device.deviceId ? "Activating..." : "Reactivate"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
