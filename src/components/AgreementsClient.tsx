"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import {
  acceptParticipationAgreement,
  getParticipationAgreementDocument,
  presentControlledAgreement,
  setBusinessLegalProfile,
  type AgreementOnboardingState,
  type GovernanceResponse,
} from "@/lib/actions/risk-governance.actions";

interface Row {
  id: string;
  type: string;
  title: string;
  version: string;
  state: string;
  documentSha256: string;
  executedAt: string | null;
}

type DocumentView = NonNullable<
  GovernanceResponse<{
    title: string;
    version: string;
    documentText: string;
    documentSha256: string;
    state: string;
    signatoryName: string;
    signatoryRole: string;
    authenticationMethod: string;
    acceptedAt: string | null;
    executedAt: string | null;
  }>["data"]
>;

function stateLabel(state: string | null): string {
  if (!state) return "Not started";
  if (state === "presented") return "Awaiting your signature";
  if (state === "accepted") return "Signed by your business — awaiting BloomCore countersignature";
  if (state === "executed") return "Executed by both parties";
  if (state === "active") return "Executed and active";
  return state.replaceAll("_", " ");
}

export default function AgreementsClient({
  onboarding,
  rows,
}: {
  onboarding: AgreementOnboardingState;
  rows: Row[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    legalName: onboarding.legalName,
    registrationNumber: onboarding.registrationNumber,
    address: onboarding.address,
    contactEmail: onboarding.contactEmail,
    contactPhone: onboarding.contactPhone,
    dpcRegistrationStatus: onboarding.dpcRegistrationStatus,
    dpcRegistrationNumber: onboarding.dpcRegistrationNumber ?? "",
  });
  const [view, setView] = useState<DocumentView | null>(null);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [capacity, setCapacity] = useState("Director / Owner");
  const [authorityBasis, setAuthorityBasis] = useState(
    "Owner or director authorised to bind the business, as recorded on the account."
  );
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<{
    id: string;
    documentText: string;
    documentSha256: string;
    version: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function run(action: () => Promise<GovernanceResponse>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (!result.success) {
        setError(result.error ?? "That action did not work.");
        return false;
      }
      setMessage(success);
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function prepare(type: string) {
    setPrepared(null);
    setPassword("");
    setConfirmed(false);
    setActiveType(type);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await presentControlledAgreement({ type, capacity, authorityBasis });
      if (!result.success || !result.data) {
        setError(result.error ?? "The instrument could not be prepared.");
        return;
      }
      setPrepared(result.data);
      setMessage("The controlled instrument was rendered on the server. Read it in full before signing.");
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!prepared) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await acceptParticipationAgreement({
        agreementId: prepared.id,
        signatoryName: onboarding.signatoryName,
        signatoryRole: capacity,
        signatoryAuthority: authorityBasis,
        authenticationMethod: "password_reauth",
        acceptedDocumentSha256: prepared.documentSha256,
        password,
      });
      if (!result.success) {
        setError(result.error ?? "The agreement could not be signed.");
        return;
      }
      setMessage("Signed by your business. BloomCore must countersign before the instrument is executed.");
      setPrepared(null);
      setPassword("");
      setConfirmed(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    setError("");
    const result = await getParticipationAgreementDocument({ id });
    if (!result.success || !result.data) {
      setError(result.error ?? "Document could not be opened.");
      return;
    }
    setView(result.data as DocumentView);
  }

  function download() {
    if (!view) return;
    const blob = new Blob([view.documentText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${view.title.replace(/[^a-z0-9]+/gi, "-")}-${view.version}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="space-y-5" data-testid="agreements">
      {message && <Notice type="success">{message}</Notice>}
      {error && <Notice type="error">{error}</Notice>}

      <div className="rounded-xl border border-slate-100 p-4">
        <h2 className="text-sm font-bold text-slate-900">1. Business legal identity</h2>
        <p className="mt-1 text-xs text-slate-600">
          These facts populate the controlled instruments. They are taken from this form, not
          from your display name. After an agreement is executed, the legal name and
          registration number are locked; contact BloomCore support to supersede and reissue.
        </p>
        {onboarding.profileMissing.length > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            Still needed: {onboarding.profileMissing.join(", ")}.
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(["legalName", "registrationNumber", "contactEmail", "contactPhone"] as const).map((field) => (
            <label key={field} className="text-xs font-medium text-slate-700">
              {{
                legalName: "Registered legal name",
                registrationNumber: "Business registration number",
                contactEmail: "Business email",
                contactPhone: "Business phone",
              }[field]}
              <input
                className="input mt-1 w-full text-sm"
                value={form[field]}
                onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))}
              />
            </label>
          ))}
          <label className="text-xs font-medium text-slate-700 sm:col-span-2">
            Principal place of business / registered office
            <input
              className="input mt-1 w-full text-sm"
              value={form.address}
              onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm mt-3"
          disabled={busy}
          onClick={() => void run(() => setBusinessLegalProfile(form), "Business legal identity saved.")}
        >
          Save legal identity
        </button>
      </div>

      <div className="rounded-xl border border-slate-100 p-4">
        <h2 className="text-sm font-bold text-slate-900">2. Controlled instruments</h2>
        {!onboarding.registeredOfficeConfirmed && (
          <p className="mt-1 text-xs text-amber-700">
            BloomCore has not configured its registered office address. Instruments show the
            registered-office wording on record; set BLOOMCORE_REGISTERED_ADDRESS only with
            the verified address.
          </p>
        )}
        {!onboarding.bloomcoreSignatoryConfigured && (
          <p className="mt-1 text-xs text-amber-700">
            BloomCore signatory details are not configured. Presentation and countersignature
            cannot complete until BLOOMCORE_AUTHORISED_SIGNATORY_NAME and
            BLOOMCORE_AUTHORISED_SIGNATORY_CAPACITY are set from the verified profile.
          </p>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-700">
            Your capacity
            <input className="input mt-1 w-full text-sm" value={capacity} onChange={(event) => setCapacity(event.target.value)} />
          </label>
          <label className="text-xs font-medium text-slate-700">
            Authority basis
            <input className="input mt-1 w-full text-sm" value={authorityBasis} onChange={(event) => setAuthorityBasis(event.target.value)} />
          </label>
        </div>
        <ul className="mt-3 space-y-3">
          {onboarding.documents.map((doc) => (
            <li key={doc.type} className="rounded-lg border border-slate-100 px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{doc.title}</p>
                  <p className="text-[11px] text-slate-500">
                    Version {doc.version} · effective {new Date(doc.effectiveDate).toLocaleDateString()}
                    {doc.conditional ? " · conditional addendum" : ""}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700">
                  {stateLabel(doc.state)}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                Server-rendered controlled text: {doc.controlledHashConfigured ? "ready" : "not configured"}
              </p>
              {(!doc.state || doc.state === "presented") && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs mt-2"
                  disabled={busy || !onboarding.profileComplete || !onboarding.bloomcoreSignatoryConfigured || !doc.controlledHashConfigured}
                  onClick={() => void prepare(doc.type)}
                >
                  {doc.state === "presented" ? "Review and sign" : "Prepare controlled instrument"}
                </button>
              )}
            </li>
          ))}
        </ul>

        {prepared && (
          <div className="mt-4 rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-900">
              Exact controlled text · version {prepared.version}
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-500">SHA-256 {prepared.documentSha256}</p>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
              {prepared.documentText}
            </pre>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Re-enter your account password
              <input
                type="password"
                className="input mt-1 w-full text-sm"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label className="mt-2 flex items-start gap-2 text-xs text-slate-700">
              <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>
                I have read the exact text above, I am authorised to sign for the business,
                and I understand that this is a controlled legal instrument. Signing records
                my identity, capacity and the document hash as evidence. This will be
                recorded against {onboarding.signatoryName || "the authenticated account"}.
              </span>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm mt-3"
              disabled={busy || !password || !confirmed}
              onClick={() => void sign()}
            >
              Sign for the business
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-100 p-4">
        <h2 className="text-sm font-bold text-slate-900">3. Recorded documents</h2>
        <ul className="mt-2 space-y-2 text-xs">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-slate-100 px-3 py-2">
              <span className="font-semibold text-slate-900">{row.title}</span> · v{row.version} · {row.state}
              <span className="block break-all font-mono text-[11px] text-slate-500">SHA-256 {row.documentSha256}</span>
              {row.executedAt ? (
                <span className="block text-slate-500">Executed {new Date(row.executedAt).toLocaleString()}</span>
              ) : null}
              <button type="button" className="btn btn-secondary btn-xs mt-2" onClick={() => void open(row.id)}>
                View exact document
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="text-slate-500">No agreements recorded.</li>}
        </ul>
        {view && (
          <div className="mt-3 rounded-lg border border-slate-100 p-3">
            <p className="text-xs font-semibold text-slate-900">{view.title} · v{view.version} · {view.state}</p>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-500">SHA-256 {view.documentSha256}</p>
            <p className="mt-1 text-xs text-slate-600">
              Signed by {view.signatoryName || "—"} ({view.signatoryRole || "—"}) via {view.authenticationMethod || "—"}
            </p>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
              {view.documentText}
            </pre>
            <button type="button" className="btn btn-primary btn-xs mt-2" onClick={download}>
              Download exact document
            </button>
          </div>
        )}
      </div>
    </section>
  );
}