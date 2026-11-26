"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRiskOrganisationSettings } from "@/lib/actions/risk-organisation.actions";
import type { RiskOrganisationSettings } from "@/lib/risk-intelligence/organisation-profile";

export default function RiskOrganisationSettingsForm({
  settings,
  canEdit,
}: {
  settings: RiskOrganisationSettings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    registeredOffice: settings.registeredOffice,
    registeredOfficeConfirmed: settings.registeredOfficeConfirmed,
    privacyEmail: settings.privacyEmail,
    signatoryName: settings.signatoryName,
    signatoryCapacity: settings.signatoryCapacity,
    hostingProviders: settings.hostingProviders,
    hostingRegions: settings.hostingRegions,
    reason: "",
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await setRiskOrganisationSettings(form);
      if (!result.success) {
        setError(result.error ?? "The settings could not be saved.");
        return;
      }
      setMessage("Saved. The public addendum and controlled instruments now use these facts.");
      set("reason", "");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-line bg-white p-5">
      <div>
        <h2 className="text-base font-semibold text-ink-deep">BloomCore legal and hosting facts</h2>
        <p className="mt-1 text-sm text-ink-muted">
          The registered name, company number and TIN are fixed in the controlled source and cannot be edited here.
          Every save is audited. These facts populate the public privacy addendum, participation agreements and
          the employee notice template.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm text-ink md:col-span-2">
          <span className="mb-1 block font-medium">Registered office</span>
          <input
            value={form.registeredOffice}
            onChange={(event) => set("registeredOffice", event.target.value)}
            disabled={!canEdit || pending}
            placeholder="Street, city, region, Ghana"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="flex items-start gap-2 text-sm text-ink md:col-span-2">
          <input
            type="checkbox"
            checked={form.registeredOfficeConfirmed}
            onChange={(event) => set("registeredOfficeConfirmed", event.target.checked)}
            disabled={!canEdit || pending}
            className="mt-0.5"
          />
          <span>I confirm this is the registered office and may be published.</span>
        </label>
        <label className="text-sm text-ink">
          <span className="mb-1 block font-medium">Privacy contact email (owner-approved)</span>
          <input
            type="email"
            value={form.privacyEmail}
            readOnly
            disabled
            aria-readonly="true"
            title="Owner-approved public privacy contact"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-ink">
          <span className="mb-1 block font-medium">Authorised signatory name</span>
          <input
            value={form.signatoryName}
            onChange={(event) => set("signatoryName", event.target.value)}
            disabled={!canEdit || pending}
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-ink">
          <span className="mb-1 block font-medium">Signatory capacity</span>
          <input
            value={form.signatoryCapacity}
            onChange={(event) => set("signatoryCapacity", event.target.value)}
            disabled={!canEdit || pending}
            placeholder="e.g. Managing Director"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-ink">
          <span className="mb-1 block font-medium">Hosting providers</span>
          <input
            value={form.hostingProviders}
            onChange={(event) => set("hostingProviders", event.target.value)}
            disabled={!canEdit || pending}
            placeholder="Only verified processors"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-ink">
          <span className="mb-1 block font-medium">Hosting regions</span>
          <input
            value={form.hostingRegions}
            onChange={(event) => set("hostingRegions", event.target.value)}
            disabled={!canEdit || pending}
            placeholder="Countries or regions"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-ink md:col-span-2">
          <span className="mb-1 block font-medium">Reason for this change</span>
          <textarea
            value={form.reason}
            onChange={(event) => set("reason", event.target.value)}
            disabled={!canEdit || pending}
            rows={2}
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
        </label>
      </div>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      {message && <p className="text-sm text-emerald-700">{message}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={!canEdit || pending || form.reason.trim().length < 10}
        className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save organisation facts"}
      </button>
    </div>
  );
}
