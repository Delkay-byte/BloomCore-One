"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, RefreshCw, Save } from "lucide-react";
import {
  reconcileZeliSubscriptionAction,
  upsertZeliPlan,
  type PlatformSubscriptionRow,
  type PlatformZeliPlan,
} from "@/lib/actions/zeli-commerce.actions";

interface Overview {
  subscriptions: { total: number; active: number; pending: number; expired: number; cancelled: number; failed: number; refunded: number };
  revenue: { collected: number; currency: string; reliable: boolean };
  packages: Array<{ name: string; count: number }>;
  providerConfigured: boolean;
}

const EMPTY = {
  id: "",
  code: "",
  name: "",
  description: "",
  billingInterval: "month",
  price: "",
  currency: "GHS",
  features: "",
  usageAllowance: "",
  trialDays: "0",
  providerPlanCode: "",
  status: "draft",
  isPublic: false,
  reason: "",
};

export default function CommercePanel({
  overview,
  plans,
  subscriptions,
}: {
  overview: Overview;
  plans: PlatformZeliPlan[];
  subscriptions: PlatformSubscriptionRow[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reconcileReason, setReconcileReason] = useState("");

  function edit(plan: PlatformZeliPlan) {
    setForm({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description ?? "",
      billingInterval: plan.billingInterval,
      price: String(plan.price),
      currency: plan.currency,
      features: plan.features.join(", "),
      usageAllowance: plan.usageAllowance == null ? "" : String(plan.usageAllowance),
      trialDays: String(plan.trialDays),
      providerPlanCode: plan.providerPlanCode ?? "",
      status: plan.status,
      isPublic: plan.isPublic,
      reason: "",
    });
    setNotice("");
    setError("");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (form.reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    setBusy("plan");
    try {
      const result = await upsertZeliPlan({
        id: form.id || undefined,
        code: form.code,
        name: form.name,
        description: form.description,
        billingInterval: form.billingInterval,
        price: Number(form.price),
        currency: form.currency,
        features: form.features.split(",").map((value) => value.trim()).filter(Boolean),
        usageAllowance: form.usageAllowance ? Number(form.usageAllowance) : null,
        trialDays: Number(form.trialDays || 0),
        providerPlanCode: form.providerPlanCode || null,
        status: form.status,
        isPublic: form.isPublic,
        reason: form.reason,
      });
      if (!result.success) {
        setError(result.error ?? "The package could not be saved.");
        return;
      }
      setNotice("Package saved. Approved prices are now configurable by the owner.");
      setForm({ ...EMPTY });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reconcile(subscriptionId: string) {
    setError("");
    setNotice("");
    if (reconcileReason.trim().length < 10) {
      setError("Enter a reconciliation reason of at least 10 characters.");
      return;
    }
    setBusy(subscriptionId);
    try {
      const result = await reconcileZeliSubscriptionAction(subscriptionId, reconcileReason);
      if (!result.success) {
        setError(result.error ?? "Reconciliation failed.");
        return;
      }
      setNotice(`Reconciliation: ${result.data?.decision ?? "completed"}.`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="Zeli commerce" data-testid="zeli-commerce">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Subscriptions" value={overview.subscriptions.total} />
        <Metric label="Active" value={overview.subscriptions.active} />
        <Metric label="Expired / cancelled" value={overview.subscriptions.expired + overview.subscriptions.cancelled} />
        <Metric label="Failed / refunded" value={overview.subscriptions.failed + overview.subscriptions.refunded} />
      </div>

      <div className="card bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold text-slate-900">Payment status</h2>
            <p className="text-xs text-slate-500">
              Paystack {overview.providerConfigured ? "configured" : "not configured"}. Revenue is
              shown only where provider data is reliable; gross recorded value is not a settlement
              report.
            </p>
          </div>
          <span className={`badge ${overview.providerConfigured ? "badge-green" : "badge-yellow"}`}>
            {overview.providerConfigured ? "Provider ready" : "Provider missing"}
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-700">
          Recorded subscription value: {overview.revenue.currency} {overview.revenue.collected.toFixed(2)}{" "}
          <span className="text-xs text-amber-700">
            (gross; not reconciled provider revenue)
          </span>
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
          {overview.packages.map((pkg) => (
            <span key={pkg.name} className="rounded-full bg-slate-100 px-2 py-1">
              {pkg.name}: {pkg.count}
            </span>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="card bg-white">
          <h2 className="font-semibold text-slate-900">Subscription packages</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col">Price</th>
                  <th scope="col">Interval</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Edit</span></th>
                </tr>
              </thead>
              <tbody>
                {plans.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-5 text-center text-slate-500">
                      No packages configured. Add the owner-approved price below.
                    </td>
                  </tr>
                )}
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <span className="font-medium">{plan.name}</span>
                      <span className="ml-1 font-mono text-xs text-slate-400">{plan.code}</span>
                    </td>
                    <td>{plan.currency} {plan.price.toFixed(2)}</td>
                    <td>{plan.billingInterval}</td>
                    <td>
                      <span className={`badge ${plan.status === "active" ? "badge-green" : "badge-gray"}`}>
                        {plan.status}{plan.isPublic ? " · public" : ""}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="text-xs font-medium text-brand-700" onClick={() => edit(plan)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={save} className="card bg-white">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900">
            {form.id ? <Save size={16} aria-hidden /> : <Plus size={16} aria-hidden />}
            {form.id ? "Edit package" : "New package"}
          </h2>
          <div className="mt-3 grid gap-2 text-sm">
            <Field label="Code"><input className="w-full" value={form.code} maxLength={61} onChange={(e) => setForm({ ...form, code: e.target.value })} required /></Field>
            <Field label="Name"><input className="w-full" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
            <Field label="Description"><input className="w-full" value={form.description} maxLength={300} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Price"><input type="number" min="0.01" step="0.01" className="w-full" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required /></Field>
              <Field label="Currency"><input className="w-full" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} required /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Interval">
                <select className="w-full" value={form.billingInterval} onChange={(e) => setForm({ ...form, billingInterval: e.target.value })}>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </Field>
              <Field label="Status">
                <select className="w-full" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="draft">draft</option>
                  <option value="active">active</option>
                  <option value="archived">archived</option>
                </select>
              </Field>
            </div>
            <Field label="Features (comma separated)"><input className="w-full" value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Usage allowance/day"><input type="number" min="1" className="w-full" value={form.usageAllowance} onChange={(e) => setForm({ ...form, usageAllowance: e.target.value })} /></Field>
              <Field label="Trial days"><input type="number" min="0" max="90" className="w-full" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} /></Field>
            </div>
            <Field label="Paystack plan code (optional)"><input className="w-full" value={form.providerPlanCode} onChange={(e) => setForm({ ...form, providerPlanCode: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
              Publish to tenant administrators
            </label>
            <Field label="Reason (required)"><textarea className="w-full" rows={2} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
          {notice && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{notice}</p>}
          <button type="submit" className="btn btn-primary btn-sm mt-3" disabled={busy !== null}>
            {busy === "plan" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
            Save package
          </button>
        </form>
      </div>

      <div className="card bg-white">
        <h2 className="font-semibold text-slate-900">Subscriptions and reconciliation</h2>
        <label className="mt-2 block text-xs text-slate-500">
          Reconciliation reason
          <input className="mt-1 w-full" value={reconcileReason} maxLength={500} onChange={(e) => setReconcileReason(e.target.value)} placeholder="Why are you rechecking the provider?" />
        </label>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Package</th>
                <th scope="col">Status</th>
                <th scope="col">Period end</th>
                <th scope="col">Reference</th>
                <th scope="col"><span className="sr-only">Reconcile</span></th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.length === 0 && (
                <tr><td colSpan={6} className="py-5 text-center text-slate-500">No subscriptions yet.</td></tr>
              )}
              {subscriptions.map((row) => (
                <tr key={row.id}>
                  <td>{row.tenantName} <span className="font-mono text-xs text-slate-400">{row.tenantCode}</span></td>
                  <td>{row.planName}</td>
                  <td><span className={`badge ${row.status === "active" ? "badge-green" : "badge-gray"}`}>{row.status}</span></td>
                  <td className="text-xs">{row.periodEnd ? row.periodEnd.slice(0, 10) : "—"}</td>
                  <td className="font-mono text-xs">{row.reference}</td>
                  <td>
                    <button type="button" className="inline-flex items-center gap-1 text-xs text-brand-700" disabled={busy !== null || row.provider !== "paystack"} onClick={() => reconcile(row.id)}>
                      {busy === row.id ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
                      Reconcile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="card !p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  );
}
