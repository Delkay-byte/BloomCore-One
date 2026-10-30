"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { enrollTenant } from "@/lib/actions/platform.actions";

type ModuleChoice = "momo" | "susu" | "both";

interface WizardState {
  name: string;
  legalName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  moduleChoice: ModuleChoice | null;
  adminFullName: string;
  adminEmail: string;
  adminPhone: string;
}

const initial: WizardState = {
  name: "",
  legalName: "",
  contactPhone: "",
  contactEmail: "",
  address: "",
  moduleChoice: null,
  adminFullName: "",
  adminEmail: "",
  adminPhone: "",
};

export default function EnrollTenantWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>(initial);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{
    tenantId: string;
    tenantCode: string;
    adminEmail: string;
    temporaryPassword: string;
  } | null>(null);

  const momoEnabled = state.moduleChoice === "momo" || state.moduleChoice === "both";
  const susuEnabled = state.moduleChoice === "susu" || state.moduleChoice === "both";

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function validateStep(current: number): string {
    if (current === 1) {
      if (state.name.trim().length < 2) return "Enter the business name";
      if (state.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.contactEmail))
        return "Enter a valid contact email";
      return "";
    }
    if (current === 2) {
      if (!state.moduleChoice) return "Choose the business type";
      return "";
    }
    if (current === 3) {
      if (state.adminFullName.trim().length < 2) return "Enter the administrator's full name";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.adminEmail.trim()))
        return "Enter a valid administrator email";
      return "";
    }
    return "";
  }

  function next() {
    const problem = validateStep(step);
    setError(problem);
    if (!problem) setStep((s) => Math.min(5, s + 1));
  }

  function back() {
    setError("");
    setStep((s) => Math.max(1, s - 1));
  }

  async function submit() {
    for (const s of [1, 2, 3]) {
      const problem = validateStep(s);
      if (problem) {
        setStep(s);
        setError(problem);
        return;
      }
    }
    setSubmitting(true);
    setError("");
    try {
      const result = await enrollTenant({
        name: state.name,
        legalName: state.legalName || undefined,
        contactPhone: state.contactPhone || undefined,
        contactEmail: state.contactEmail || undefined,
        address: state.address || undefined,
        momoEnabled,
        susuEnabled,
        adminFullName: state.adminFullName,
        adminEmail: state.adminEmail,
        adminPhone: state.adminPhone || undefined,
      });
      if (result && !result.success) {
        setError(result.error || "Enrollment failed");
      } else if (result?.data) {
        const data = result.data as {
          tenantId: string;
          tenantCode: string;
          adminEmail: string;
          temporaryPassword: string;
        };
        setCreated(data);
      }
    } catch {
      setError("An unexpected error occurred during enrollment");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success screen: one-time credential handover ──────────────────────
  if (created) {
    return (
      <div className="max-w-2xl space-y-6">
        <div className="card bg-white">
          <h1 className="text-xl font-bold text-gray-900 mb-1">Business enrolled</h1>
          <p className="text-sm text-gray-500 mb-6">
            {state.name} is now enrolled on the platform.
          </p>

          <dl className="space-y-2 text-sm mb-6">
            <div className="flex justify-between">
              <dt className="text-gray-500">Business</dt>
              <dd className="text-gray-900">{state.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Tenant code</dt>
              <dd className="font-mono text-gray-900">{created.tenantCode}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Enabled modules</dt>
              <dd className="text-gray-900">{moduleLabel(momoEnabled, susuEnabled)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Administrator</dt>
              <dd className="text-gray-900">{created.adminEmail}</dd>
            </div>
          </dl>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm font-semibold text-amber-800 mb-1">
              One-time administrator password
            </p>
            <p className="text-xs text-amber-700 mb-3">
              Give this password to the business administrator now — it is shown
              only once and cannot be retrieved later. The administrator must
              change it at first sign-in.
            </p>
            <code className="block bg-white border border-amber-300 rounded px-3 py-2 text-center text-lg font-mono tracking-widest select-all">
              {created.temporaryPassword}
            </code>
          </div>

          <div className="flex gap-2 mt-6">
            <button
              onClick={() => router.push(`/platform/tenants/${created.tenantId}`)}
              className="btn btn-primary"
            >
              Open business page
            </button>
            <button onClick={() => router.push("/platform/tenants")} className="btn border border-gray-300 text-gray-600 hover:bg-gray-50">
              Back to directory
            </button>
          </div>
        </div>
      </div>
    );
  }

  const stepTitles = ["Business information", "Business type", "Administrator", "Initial configuration", "Review"];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Enroll a Business</h1>
        <p className="text-sm text-gray-500 mt-1">
          Register a new business on the platform with its own isolated data and administrator.
        </p>
      </div>

      {/* Step indicator */}
      <ol className="flex gap-2 text-xs">
        {stepTitles.map((title, i) => (
          <li
            key={title}
            className={`flex-1 rounded-lg px-2 py-2 text-center border ${
              step === i + 1
                ? "border-slate-800 bg-slate-800 text-white"
                : step > i + 1
                  ? "border-green-200 bg-green-50 text-green-700"
                  : "border-gray-200 bg-white text-gray-400"
            }`}
          >
            {step > i + 1 ? "✓ " : `${i + 1}. `}
            {title}
          </li>
        ))}
      </ol>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="card bg-white">
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-900">Step 1 — Business information</h2>
            <Field label="Business name" required value={state.name} onChange={(v) => update("name", v)} placeholder="e.g. Adom Mobile Money" />
            <Field label="Legal / registered name (if different)" value={state.legalName} onChange={(v) => update("legalName", v)} placeholder="Registered company name" />
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Contact phone" value={state.contactPhone} onChange={(v) => update("contactPhone", v)} placeholder="+233…" />
              <Field label="Contact email" type="email" value={state.contactEmail} onChange={(v) => update("contactEmail", v)} placeholder="owner@business.com" />
            </div>
            <Field label="Business address" value={state.address} onChange={(v) => update("address", v)} placeholder="Street, town" />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-900">Step 2 — Select business type</h2>
            <p className="text-sm text-gray-500">
              This choice sets the business&apos;s server-side module entitlements. It can be
              changed later, but the business only ever operates the modules it is enrolled for.
            </p>
            <div className="space-y-3">
              <ModuleOption
                selected={state.moduleChoice === "momo"}
                onSelect={() => update("moduleChoice", "momo")}
                title="MoMo Business Only"
                description="Mobile money operations: locations, workers, daily accounts, expenses, reconciliation, reports. No Susu operations."
              />
              <ModuleOption
                selected={state.moduleChoice === "susu"}
                onSelect={() => update("moduleChoice", "susu")}
                title="Susu Agency Only"
                description="Susu savings operations: customers, accounts, collectors, contributions, withdrawals, Money Handed In. No MoMo operations."
              />
              <ModuleOption
                selected={state.moduleChoice === "both"}
                onSelect={() => update("moduleChoice", "both")}
                title="MoMo + Susu Business"
                description="Operates both modules with full data isolation between them and between businesses."
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-900">Step 3 — Primary tenant administrator</h2>
            <p className="text-sm text-gray-500">
              A dedicated administrator account is created for this business. The
              administrator signs in through the standard business login and manages
              only this business.
            </p>
            <Field label="Administrator full name" required value={state.adminFullName} onChange={(v) => update("adminFullName", v)} placeholder="e.g. Akua Darko" />
            <Field label="Administrator email (sign-in)" type="email" required value={state.adminEmail} onChange={(v) => update("adminEmail", v)} placeholder="admin@business.com" />
            <Field label="Administrator phone" value={state.adminPhone} onChange={(v) => update("adminPhone", v)} placeholder="+233…" />
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-xs text-gray-600">
              A secure one-time temporary password is generated for the administrator and
              shown once at the end of enrollment. Only its hash is stored, and the
              administrator must set a new password at first sign-in.
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-900">Step 4 — Initial configuration</h2>
            {momoEnabled ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">MoMo module</p>
                After enrollment, the business administrator creates its own locations
                and workers from the business dashboard. No MoMo locations are created
                automatically — a business starts with the locations it actually operates.
              </div>
            ) : (
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">MoMo module</p>
                This business is not enrolled for MoMo, so no MoMo configuration is needed.
              </div>
            )}
            {susuEnabled ? (
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">Susu module</p>
                After enrollment, the business administrator registers customers and
                provisions collectors from the business dashboard. No customers or
                collectors are created automatically.
              </div>
            ) : (
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">Susu module</p>
                This business is not enrolled for Susu, so no agency setup is needed.
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <h2 className="font-semibold text-gray-900">Step 5 — Review and confirm</h2>
            <dl className="space-y-2 text-sm">
              <Review label="Business name" value={state.name} />
              <Review label="Legal name" value={state.legalName || "—"} />
              <Review label="Contact" value={[state.contactPhone, state.contactEmail].filter(Boolean).join(" · ") || "—"} />
              <Review label="Business type" value={moduleLabel(momoEnabled, susuEnabled)} />
              <Review label="Enabled modules" value={[momoEnabled && "MoMo", susuEnabled && "Susu"].filter(Boolean).join(", ")} />
              <Review label="Primary administrator" value={`${state.adminFullName} (${state.adminEmail})`} />
              <Review label="Initial status" value="Active" />
            </dl>
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800">
              Confirming creates the business, its isolated data boundary and its
              administrator account in one atomic operation. Nothing is created if any
              part fails.
            </div>
          </div>
        )}

        <div className="flex justify-between mt-6 pt-4 border-t border-gray-100">
          <button
            onClick={back}
            disabled={step === 1 || submitting}
            className="btn border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            ← Back
          </button>
          {step < 5 ? (
            <button onClick={next} className="btn btn-primary">
              Continue →
            </button>
          ) : (
            <button onClick={submit} className="btn btn-primary" disabled={submitting}>
              {submitting ? (
                <span className="flex items-center gap-2">
                  <span className="spinner" /> Enrolling...
                </span>
              ) : (
                "Confirm enrollment"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function moduleLabel(momo: boolean, susu: boolean) {
  if (momo && susu) return "MoMo + Susu Business";
  if (momo) return "MoMo Business Only";
  if (susu) return "Susu Agency Only";
  return "—";
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="form-group">
      <label className="form-label">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5"
      />
    </div>
  );
}

function ModuleOption({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-lg border-2 px-4 py-3 transition-colors ${
        selected ? "border-slate-800 bg-slate-50" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-900">{title}</span>
        <span
          className={`h-4 w-4 rounded-full border-2 ${
            selected ? "border-slate-800 bg-slate-800" : "border-gray-300"
          }`}
        />
      </div>
      <p className="text-sm text-gray-500 mt-1">{description}</p>
    </button>
  );
}

function Review({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 text-right">{value}</dd>
    </div>
  );
}
