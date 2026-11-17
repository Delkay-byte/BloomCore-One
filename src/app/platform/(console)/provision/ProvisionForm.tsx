"use client";

import { useState } from "react";
import { provisionBusinessAction } from "@/lib/actions/provisioning.actions";
import type { ProvisioningPlanOption } from "@/lib/actions/provisioning.actions";

export default function ProvisionForm({
  plans,
  foundingRemaining,
  enquiry,
}: {
  plans: ProvisioningPlanOption[];
  foundingRemaining: number;
  enquiry: {
    id: string;
    businessName: string;
    contactName: string;
    phone: string;
    email: string | null;
    locationCount: number | null;
    interestedPlan: string | null;
  } | null;
}) {
  const [form, setForm] = useState({
    name: enquiry?.businessName ?? "",
    legalName: "",
    contactPhone: enquiry?.phone ?? "",
    contactEmail: enquiry?.email ?? "",
    address: "",
    momoEnabled: true,
    susuEnabled: true,
    adminFullName: enquiry?.contactName ?? "",
    adminEmail: enquiry?.email ?? "",
    adminPhone: enquiry?.phone ?? "",
    planCode: plans[0]?.code ?? "",
    foundingOptIn: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    tenantCode: string;
    adminEmail: string;
    temporaryPassword: string;
    planName: string;
    amount: number;
    billingTerm: string;
    paymentReference: string;
    foundingSlot: number | null;
  } | null>(null);

  const plan = plans.find((row) => row.code === form.planCode);
  const foundingAvailable = foundingRemaining > 0 && plan?.foundingPrice != null && plan.billingInterval === "month";
  const amount = form.foundingOptIn && foundingAvailable ? plan?.foundingPrice : plan?.price;

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await provisionBusinessAction({ ...form, enquiryId: enquiry?.id ?? null });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult({
        tenantCode: response.tenantCode,
        adminEmail: response.adminEmail,
        temporaryPassword: response.temporaryPassword,
        planName: response.planName,
        amount: response.amount,
        billingTerm: response.billingTerm,
        paymentReference: response.paymentReference,
        foundingSlot: response.foundingSlot,
      });
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="text-base font-semibold text-emerald-900">Business provisioned in pending payment</h2>
          <p className="mt-1 text-sm text-emerald-900">
            Nothing has been charged. The administrator signs in, verifies the e-mail address and completes the first
            payment from Billing.
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-emerald-800">Business code</dt>
              <dd className="font-mono font-semibold text-emerald-950">{result.tenantCode}</dd>
            </div>
            <div>
              <dt className="text-emerald-800">Administrator</dt>
              <dd className="font-medium text-emerald-950">{result.adminEmail}</dd>
            </div>
            <div>
              <dt className="text-emerald-800">Package</dt>
              <dd className="font-medium text-emerald-950">
                {result.planName} · {result.billingTerm}
              </dd>
            </div>
            <div>
              <dt className="text-emerald-800">First payment</dt>
              <dd className="font-medium text-emerald-950">GH₵{result.amount.toLocaleString("en-GH")}</dd>
            </div>
            <div>
              <dt className="text-emerald-800">Founding slot</dt>
              <dd className="font-medium text-emerald-950">{result.foundingSlot ?? "Not applied"}</dd>
            </div>
            <div>
              <dt className="text-emerald-800">Payment reference</dt>
              <dd className="font-mono text-xs text-emerald-950">{result.paymentReference}</dd>
            </div>
          </dl>
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
              One-time credential — hand over out of band
            </p>
            <p className="mt-1 font-mono text-sm text-amber-950">{result.temporaryPassword}</p>
            <p className="mt-1 text-xs text-amber-800">
              Shown once. It is never logged or e-mailed in plain text. The administrator must change it at first sign-in.
            </p>
          </div>
        </div>
        <a href="/platform/enquiries" className="btn btn-secondary btn-sm inline-flex">
          Back to enquiries
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">
        {enquiry ? `Provision ${enquiry.businessName}` : "Provision a business"}
      </h2>
      <p className="text-sm text-slate-600">
        Creates the business in <strong>pending payment</strong>, assigns the package and a founding slot when requested,
        and invites the first administrator. No charge, no activation.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-slate-700">Business name</span>
          <input className="input mt-1 w-full" value={form.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Registered legal name (optional)</span>
          <input className="input mt-1 w-full" value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Contact phone</span>
          <input className="input mt-1 w-full" value={form.contactPhone} onChange={(e) => set("contactPhone", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Contact e-mail</span>
          <input className="input mt-1 w-full" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-slate-700">Address (optional)</span>
          <input className="input mt-1 w-full" value={form.address} onChange={(e) => set("address", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Administrator full name</span>
          <input className="input mt-1 w-full" value={form.adminFullName} onChange={(e) => set("adminFullName", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Administrator e-mail</span>
          <input className="input mt-1 w-full" value={form.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-700">Administrator phone (optional)</span>
          <input className="input mt-1 w-full" value={form.adminPhone} onChange={(e) => set("adminPhone", e.target.value)} />
        </label>
        <div className="flex items-end gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.momoEnabled} onChange={(e) => set("momoEnabled", e.target.checked)} />
            <span className="text-slate-700">MoMo</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.susuEnabled} onChange={(e) => set("susuEnabled", e.target.checked)} />
            <span className="text-slate-700">Susu</span>
          </label>
        </div>
        <label className="text-sm">
          <span className="text-slate-700">Package</span>
          <select className="input mt-1 w-full" value={form.planCode} onChange={(e) => set("planCode", e.target.value)}>
            {plans.map((row) => (
              <option key={row.code} value={row.code}>
                {row.name} · GH₵{row.price.toLocaleString("en-GH")} / {row.billingInterval}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.foundingOptIn}
              disabled={!foundingAvailable}
              onChange={(e) => set("foundingOptIn", e.target.checked)}
            />
            <span className="text-slate-700">
              Founding slot {foundingAvailable ? `(${foundingRemaining} left)` : "(not available for this plan)"}
            </span>
          </label>
        </div>
      </div>

      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
        First payment: <strong>GH₵{(amount ?? 0).toLocaleString("en-GH")}</strong>
        {form.foundingOptIn && foundingAvailable
          ? " (founding price for the first three monthly periods; standard price from the fourth)"
          : " (standard price)"}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
        {busy ? "Provisioning…" : "Provision business"}
      </button>
    </div>
  );
}
