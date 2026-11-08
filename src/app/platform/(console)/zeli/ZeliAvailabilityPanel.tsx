"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Power, ShieldAlert, ShieldCheck } from "lucide-react";
import { setZeliAvailability } from "@/lib/actions/zeli-availability.actions";
import { formatDateTime } from "@/lib/utils";
import { useConfirm } from "@/components/ui/useConfirm";

interface AvailabilityState {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedById: string | null;
  source: string;
}

export default function ZeliAvailabilityPanel({
  availability,
  updatedByName,
}: {
  availability: AvailabilityState;
  updatedByName: string | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, confirmNode } = useConfirm();

  async function change(enabled: boolean) {
    setError("");
    setNotice("");
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    const confirmation = await confirm(
      enabled
        ? "Enable Zeli for every tenant? Existing subscriptions and data are unchanged."
        : "Disable all tenant-facing Zeli features immediately? Conversations, analytics, subscriptions and payments are preserved, but users cannot use Zeli until it is re-enabled.",
      { title: enabled ? "Enable Zeli globally?" : "Disable Zeli globally?" }
    );
    if (!confirmation) return;
    setBusy(enabled ? "on" : "off");
    try {
      const result = await setZeliAvailability({ enabled, reason });
      if (!result.success) {
        setError(result.error ?? "The change failed.");
        return;
      }
      setNotice(enabled ? "Zeli is now ON for all tenants." : "Zeli is now OFF for all tenants.");
      setReason("");
      router.refresh();
    } catch {
      setError("The change failed. The previous setting may still apply.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={`card border-2 ${availability.enabled ? "border-emerald-200" : "border-red-300"}`}
      aria-label="Global Zeli Availability"
      data-testid="zeli-availability"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Entire product
          </p>
          <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900">
            {availability.enabled ? (
              <ShieldCheck size={20} className="text-emerald-700" aria-hidden />
            ) : (
              <ShieldAlert size={20} className="text-red-700" aria-hidden />
            )}
            Global Zeli Availability
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            This master switch controls every tenant-facing Zeli feature: chat,
            conversations, analytics, exports, insights and recommendations. It
            does not change subscriptions, payments, entitlements or audit data.
          </p>
        </div>
        <span className={`badge self-start text-sm ${availability.enabled ? "badge-green" : "badge-red"}`}>
          ZELI {availability.enabled ? "ON" : "OFF"}
        </span>
      </div>

      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Current status</dt>
          <dd className="font-semibold text-slate-900">
            {availability.enabled ? "Available to tenants" : "Unavailable to tenants"}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">Last change</dt>
          <dd className="text-right font-medium text-slate-800">
            {availability.updatedAt
              ? `${formatDateTime(availability.updatedAt)}${updatedByName ? ` · ${updatedByName}` : ""}`
              : "No recorded change"}
          </dd>
        </div>
        <div className="flex justify-between gap-3 sm:col-span-2">
          <dt className="text-slate-500">Reason</dt>
          <dd className="text-right text-slate-700">{availability.reason ?? "—"}</dd>
        </div>
      </dl>

      <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-3">
        <p><strong>1. Entire Zeli</strong><br />This master switch. Turns all tenant Zeli features off/on.</p>
        <p><strong>2. External-AI mode</strong><br />Separate policy: disabled, synthetic or approved production.</p>
        <p><strong>3. DeepSeek stop / entitlement</strong><br />The provider emergency stop is independent. A tenant subscription is also independent.</p>
      </div>

      <label className="mt-3 block text-sm">
        <span className="font-medium text-slate-700">Reason (required, min 10 characters)</span>
        <textarea
          className="mt-1 w-full"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy !== null || availability.enabled}
          onClick={() => change(true)}
        >
          {busy === "on" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Power size={13} aria-hidden />}
          Enable Zeli
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy !== null || !availability.enabled}
          onClick={() => change(false)}
        >
          {busy === "off" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Power size={13} aria-hidden />}
          Disable Zeli
        </button>
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
      {notice && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{notice}</p>}
      {confirmNode}
    </section>
  );
}
