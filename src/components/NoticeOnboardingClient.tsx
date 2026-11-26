"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import { recordEmployeeNoticeAttestation } from "@/lib/actions/risk-governance.actions";

export interface NoticeEmployeeRow {
  userId: string;
  fullName: string;
  role: string;
  state: string | null;
  deliveryMethod: string | null;
  evidence: string | null;
  verified: boolean;
  acknowledgedAt: string | null;
  failureReason: string | null;
}

const METHODS = [
  ["portal_acknowledgement", "Portal acknowledgement"],
  ["email", "Email (provider receipt retained)"],
  ["sms", "SMS (gateway receipt retained)"],
  ["in_person", "In person (signed record retained)"],
  ["printed", "Printed copy (signed record retained)"],
] as const;

export default function NoticeOnboardingClient({
  noticeVersion,
  employees,
}: {
  noticeVersion: string | null;
  employees: NoticeEmployeeRow[];
}) {
  const router = useRouter();
  const [userId, setUserId] = useState(employees[0]?.userId ?? "");
  const [deliveryMethod, setDeliveryMethod] = useState<string>("portal_acknowledgement");
  const [acknowledgementState, setAcknowledgementState] = useState<"delivered" | "acknowledged" | "failed">("acknowledged");
  const [evidence, setEvidence] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [evidenceVerified, setEvidenceVerified] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selected = useMemo(
    () => employees.find((employee) => employee.userId === userId) ?? null,
    [employees, userId]
  );

  async function submit() {
    if (!noticeVersion) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await recordEmployeeNoticeAttestation({
        userId,
        noticeVersion,
        deliveryMethod,
        deliveryEvidence: evidence,
        acknowledgementState,
        acknowledgedAt: acknowledgementState === "acknowledged" ? new Date().toISOString() : null,
        evidenceVerified,
        failureReason: acknowledgementState === "failed" ? failureReason : undefined,
      });
      if (!result.success) {
        setError(result.error ?? "The notice record could not be saved.");
        return;
      }
      setMessage(
        acknowledgementState === "failed"
          ? "Failed delivery recorded. This does not satisfy the notice gate."
          : acknowledgementState === "acknowledged"
            ? evidenceVerified
              ? "Acknowledged delivery recorded and verified. It satisfies the notice gate for this employee."
              : "Delivery recorded but not verified. It does not satisfy the notice gate."
            : "Delivery recorded. Acknowledgement is still outstanding."
      );
      setEvidence("");
      setFailureReason("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!noticeVersion) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        No employee privacy notice has been published by BloomCore. Owners cannot record
        attestations until the controlled notice is published. Employees see a provisional
        statutory notice at first login in the meantime; that provisional text does not satisfy
        the contribution gate.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="notice-onboarding">
      {message && <Notice type="success">{message}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      <p className="text-xs text-slate-600">
        Record what actually happened for each employee. A portal acknowledgement, email receipt,
        SMS receipt or signed in-person record is evidence; a failed or returned delivery is
        stored but never counted as verification. Acknowledgement is not consent.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-700">
          Employee
          <select className="input mt-1 w-full text-sm" value={userId} onChange={(event) => setUserId(event.target.value)}>
            {employees.map((employee) => (
              <option key={employee.userId} value={employee.userId}>
                {employee.fullName} · {employee.role}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Delivery method
          <select className="input mt-1 w-full text-sm" value={deliveryMethod} onChange={(event) => setDeliveryMethod(event.target.value)}>
            {METHODS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Outcome
          <select
            className="input mt-1 w-full text-sm"
            value={acknowledgementState}
            onChange={(event) => setAcknowledgementState(event.target.value as typeof acknowledgementState)}
          >
            <option value="acknowledged">Acknowledged</option>
            <option value="delivered">Delivered — not yet acknowledged</option>
            <option value="failed">Failed / returned</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Delivery evidence reference
          <input
            className="input mt-1 w-full text-sm"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="Portal acknowledgement ID, provider message ID, signed sheet reference"
          />
        </label>
        {acknowledgementState === "failed" && (
          <label className="text-xs font-medium text-slate-700 sm:col-span-2">
            Why did delivery fail?
            <input className="input mt-1 w-full text-sm" value={failureReason} onChange={(event) => setFailureReason(event.target.value)} />
          </label>
        )}
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" className="mt-0.5" checked={evidenceVerified} onChange={(event) => setEvidenceVerified(event.target.checked)} />
        <span>I checked the evidence reference and confirm it belongs to this employee and this notice version.</span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={busy || !userId || evidence.trim().length < 5}
        onClick={() => void submit()}
      >
        Record notice evidence
      </button>

      <ul className="mt-3 space-y-2 text-xs">
        {employees.map((employee) => (
          <li key={employee.userId} className="rounded-lg border border-slate-100 px-3 py-2">
            <span className="font-semibold text-slate-900">{employee.fullName}</span> · {employee.role} ·{" "}
            {employee.state ?? "no record"} {employee.verified ? "· verified" : ""}
            {employee.deliveryMethod ? ` · ${employee.deliveryMethod}` : ""}
            {employee.acknowledgedAt ? ` · acknowledged ${new Date(employee.acknowledgedAt).toLocaleString()}` : ""}
            {employee.failureReason ? ` · failed: ${employee.failureReason}` : ""}
          </li>
        ))}
        {employees.length === 0 && <li className="text-slate-500">No active workers or collectors yet.</li>}
      </ul>
      {selected?.verified && (
        <p className="text-[11px] text-slate-500">
          {selected.fullName} already has a verified acknowledgement for the current notice. A new
          record replaces the evidence but does not change the fact of acknowledgement.
        </p>
      )}
    </div>
  );
}
