"use client";

import { useState } from "react";
import { assignPackageToTenantAction } from "@/lib/actions/provisioning.actions";

export default function AssignPackageForm({
  tenants,
  plans,
}: {
  tenants: Array<{ tenantId: string; code: string; name: string }>;
  plans: Array<{ code: string; name: string; billingInterval: string; price: number; foundingPrice: number | null }>;
}) {
  const [tenantId, setTenantId] = useState(tenants[0]?.tenantId ?? "");
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? "");
  const [founding, setFounding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await assignPackageToTenantAction({ tenantId, planCode, foundingOptIn: founding });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(`Assigned. The business will pay GH₵${result.amount.toLocaleString("en-GH")} from Billing. Nothing was charged.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">Assign a package to an existing business</h2>
      <p className="mt-1 text-sm text-slate-600">
        Creates a pending payment for the business. It never charges, suspends or deletes anything.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="text-slate-700">Business</span>
          <select className="input mt-1 w-full" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            {tenants.map((tenant) => (
              <option key={tenant.tenantId} value={tenant.tenantId}>
                {tenant.code} — {tenant.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Package</span>
          <select className="input mt-1 w-full" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name} · GH₵{plan.price.toLocaleString("en-GH")} / {plan.billingInterval}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 text-sm">
          <input type="checkbox" checked={founding} onChange={(e) => setFounding(e.target.checked)} />
          <span className="text-slate-700">Apply a founding slot if available</span>
        </label>
      </div>
      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      {message && <p className="mt-3 text-sm text-emerald-700">{message}</p>}
      <button type="button" className="btn btn-primary mt-4" disabled={busy || !tenantId} onClick={submit}>
        {busy ? "Assigning…" : "Assign package"}
      </button>
    </section>
  );
}
