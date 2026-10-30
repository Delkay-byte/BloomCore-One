"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal, { ConfirmDialog } from "@/components/ui/Modal";
import {
  resetTenantAdminAccess,
  setTenantStatus,
  updateTenantModules,
  updateTenantProfile,
} from "@/lib/actions/platform.actions";

interface TenantInfo {
  id: string;
  name: string;
  legalName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  status: string;
}

export default function TenantManagement({
  tenant,
  primaryAdmin,
}: {
  tenant: TenantInfo;
  primaryAdmin: { id: string; email: string } | null;
}) {
  const router = useRouter();

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <ProfilePanel tenant={tenant} onDone={() => router.refresh()} />
      <ModulePanel tenant={tenant} onDone={() => router.refresh()} />
      <StatusPanel tenant={tenant} onDone={() => router.refresh()} />
      <RecoveryPanel tenant={tenant} primaryAdmin={primaryAdmin} onDone={() => router.refresh()} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit business profile
// ---------------------------------------------------------------------------

function ProfilePanel({ tenant, onDone }: { tenant: TenantInfo; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    setSuccess(false);
    const result = await updateTenantProfile(tenant.id, formData);
    setLoading(false);
    if (result && !result.success) {
      setError(result.error || "Update failed");
    } else {
      setSuccess(true);
      onDone();
    }
  }

  return (
    <div className="card bg-white">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900">Business profile</h2>
        {!open && (
          <button onClick={() => setOpen(true)} className="text-sm text-slate-700 hover:text-slate-900 font-medium">
            Edit
          </button>
        )}
      </div>
      {open ? (
        <form action={handleSubmit} className="space-y-3">
          {error && <FormError message={error} />}
          {success && <FormSuccess message="Profile updated." />}
          <Input name="name" label="Business name" defaultValue={tenant.name} required />
          <Input name="legalName" label="Legal name" defaultValue={tenant.legalName} />
          <div className="grid sm:grid-cols-2 gap-3">
            <Input name="contactPhone" label="Contact phone" defaultValue={tenant.contactPhone} />
            <Input name="contactEmail" label="Contact email" type="email" defaultValue={tenant.contactEmail} />
          </div>
          <Input name="address" label="Address" defaultValue={tenant.address} />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm" disabled={loading}>
              {loading ? "Saving..." : "Save changes"}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setError(""); }}
              className="btn border border-slate-300 text-slate-600 text-sm hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-slate-500">
          Update the business identity and contact details.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module configuration
// ---------------------------------------------------------------------------

function ModulePanel({ tenant, onDone }: { tenant: TenantInfo; onDone: () => void }) {
  const [momo, setMomo] = useState(tenant.momoEnabled);
  const [susu, setSusu] = useState(tenant.susuEnabled);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const unchanged = momo === tenant.momoEnabled && susu === tenant.susuEnabled;
  const disablingMomo = tenant.momoEnabled && !momo;
  const disablingSusu = tenant.susuEnabled && !susu;
  const bothDisabled = !momo && !susu;

  async function apply() {
    setLoading(true);
    setError("");
    const result = await updateTenantModules(tenant.id, momo, susu);
    setLoading(false);
    if (result && !result.success) {
      setError(result.error || "Update failed");
    } else {
      setConfirming(false);
      onDone();
    }
  }

  return (
    <div className="card bg-white">
      <h2 className="font-semibold text-slate-900 mb-1">Module configuration</h2>
      <p className="text-xs text-slate-500 mb-4">
        Controls which modules this business may operate server-side. Historical
        records are never deleted when a module is disabled.
      </p>
      {error && <FormError message={error} />}
      <div className="space-y-3">
        <Toggle
          label="MoMo module"
          description="Locations, workers, daily accounts, expenses, reconciliation"
          checked={momo}
          onChange={setMomo}
        />
        <Toggle
          label="Susu module"
          description="Customers, accounts, collectors, contributions, withdrawals"
          checked={susu}
          onChange={setSusu}
        />
      </div>
      {bothDisabled && (
        <p className="text-xs text-red-600 mt-3">
          A business cannot operate with both modules disabled. Suspend the tenant instead.
        </p>
      )}
      <button
        onClick={() => setConfirming(true)}
        disabled={unchanged || bothDisabled}
        className="btn btn-primary text-sm mt-4 disabled:opacity-50"
      >
        Apply module change
      </button>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirm module change"
        footer={
          <>
            <button onClick={() => setConfirming(false)} className="btn btn-secondary btn-sm">
              Cancel
            </button>
            <button onClick={apply} disabled={loading} className="btn btn-primary btn-sm">
              {loading ? (
                <>
                  <span className="spinner spinner-sm" aria-hidden /> Applying…
                </>
              ) : (
                "Confirm change"
              )}
            </button>
          </>
        }
      >
        {disablingMomo && !disablingSusu && (
          <p>Disabling MoMo will hide MoMo from this business&apos;s users and reject all
          MoMo operations and API requests. Existing MoMo records are preserved.</p>
        )}
        {disablingSusu && !disablingMomo && (
          <p>Disabling Susu will hide Susu from this business&apos;s users and reject all
          Susu operations, including the customer portal. Existing Susu records are
          preserved.</p>
        )}
        {disablingMomo && disablingSusu && (
          <p>This would disable both modules — not allowed. Suspend the tenant instead.</p>
        )}
        {!disablingMomo && !disablingSusu && (
          <p>Enabling the selected module(s) will make their features available to this
          business immediately.</p>
        )}
      </Modal>    </div>
  );
}

// ---------------------------------------------------------------------------
// Activation / suspension
// ---------------------------------------------------------------------------

function StatusPanel({ tenant, onDone }: { tenant: TenantInfo; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const canSuspend = tenant.status === "ACTIVE" || tenant.status === "PROVISIONING";
  const canActivate = tenant.status === "SUSPENDED" || tenant.status === "PROVISIONING";

  async function act(action: "activate" | "suspend" | "reactivate") {
    setLoading(true);
    setError("");
    const result = await setTenantStatus(tenant.id, action, action === "activate" ? undefined : reason);
    setLoading(false);
    if (result && !result.success) {
      setError(result.error || "Action failed");
    } else {
      setReason("");
      onDone();
    }
  }

  return (
    <div className="card bg-white">
      <h2 className="font-semibold text-slate-900 mb-1">Lifecycle</h2>
      <p className="text-xs text-slate-500 mb-4">
        Suspension immediately blocks sign-in and all protected operations for this
        business. All records — including financial history — are preserved.
      </p>
      {error && <FormError message={error} />}
      {canSuspend && (
        <div className="form-group">
          <label className="form-label" htmlFor="suspend-reason">Reason (required to suspend)</label>
          <textarea
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why is this business being suspended?"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {canSuspend && (
          <button
            onClick={() => act("suspend")}
            disabled={loading || reason.trim().length < 3}
            className="btn text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            Suspend business
          </button>
        )}
        {canActivate && (
          <button
            onClick={() => act(tenant.status === "SUSPENDED" ? "reactivate" : "activate")}
            disabled={loading}
            className="btn text-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {tenant.status === "SUSPENDED" ? "Reactivate business" : "Activate business"}
          </button>
        )}
        {tenant.status === "ACTIVE" && !canActivate && !canSuspend && null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Administrator recovery
// ---------------------------------------------------------------------------

function RecoveryPanel({
  tenant,
  primaryAdmin,
  onDone,
}: {
  tenant: TenantInfo;
  primaryAdmin: { id: string; email: string } | null;
  onDone: () => void;
}) {
  const [oneTime, setOneTime] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function reset() {
    if (!primaryAdmin) return;
    setConfirming(false);
    setLoading(true);
    setError("");
    const result = await resetTenantAdminAccess(tenant.id, primaryAdmin.id);
    setLoading(false);
    if (result && !result.success) {
      setError(result.error || "Recovery failed");
    } else if (result?.data) {
      const data = result.data as { temporaryPassword: string };
      setOneTime(data.temporaryPassword);
      onDone();
    }
  }

  return (
    <div className="card bg-white">
      <h2 className="font-semibold text-slate-900 mb-1">Administrator recovery</h2>
      <p className="text-xs text-slate-500 mb-4">
        If the business administrator is locked out, issue a secure one-time
        temporary password. Their current password is never shown or retrievable.
      </p>
      {error && <FormError message={error} />}
      {primaryAdmin ? (
        <>
          <p className="text-sm text-slate-700 mb-3">{primaryAdmin.email}</p>
          <button onClick={() => setConfirming(true)} disabled={loading} className="btn btn-secondary btn-sm">
            {loading ? "Issuing…" : "Issue one-time password"}
          </button>
          <ConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            onConfirm={reset}
            title="Issue one-time password"
            description={`A one-time temporary password will be issued for ${primaryAdmin.email}. Their current sessions are signed out and a password change is forced at next sign-in.`}
            confirmLabel="Issue password"
          />
          {oneTime && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mt-4">
              <p className="text-sm font-semibold text-amber-800 mb-1">One-time password</p>
              <p className="text-xs text-amber-700 mb-2">
                Shown once — hand it to the administrator securely now.
              </p>
              <code className="block bg-white border border-amber-300 rounded px-3 py-2 text-center text-lg font-mono tracking-widest select-all">
                {oneTime}
              </code>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-amber-600">No administrator to recover.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Input({
  name,
  label,
  defaultValue,
  type = "text",
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={`profile-${name}`}>
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={`profile-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`w-full text-left rounded-lg border px-4 py-3 flex items-center justify-between gap-4 transition-colors ${
        checked ? "border-slate-300 bg-slate-50" : "border-slate-200"
      }`}
    >
      <span>
        <span className="block font-medium text-slate-900 text-sm">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
      <span
        className={`flex-none relative inline-flex h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-slate-800" : "bg-gray-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function FormError({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm mb-3">
      {message}
    </div>
  );
}

function FormSuccess({ message }: { message: string }) {
  return (
    <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-lg text-sm mb-3">
      ✓ {message}
    </div>
  );
}
