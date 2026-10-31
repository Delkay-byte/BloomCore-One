"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Compatibility redirect — Offline Devices moved to Settings.
 * Anyone visiting /admin/devices is sent to the Settings page
 * with the devices tab active.
 */
export default function AdminDevicesRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/settings?tab=devices");
  }, [router]);

  return (
    <div className="min-h-[50vh] flex items-center justify-center">
      <div className="text-center">
        <div className="spinner mb-4"></div>
        <p className="text-slate-500 text-sm">Redirecting to Settings → Offline Devices...</p>
      </div>
    </div>
  );
}
