"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Notice from "@/components/ui/Notice";
import { countersignParticipationAgreement } from "@/lib/actions/risk-governance.actions";

export interface PendingAgreement {
  id: string;
  tenantName: string;
  type: string;
  version: string;
  signatoryName: string;
  acceptedAt: string | null;
}

/**
 * Platform-owner execution path. A business or agent agreement can be
 * countersigned here without any DPO/DPS account or approval. The signing
 * certificate still names BloomCore's configured authorised signatory, and
 * execution fails closed if that signatory is not configured.
 */
export default function PlatformCountersignPanel({
  agreements,
}: {
  agreements: PendingAgreement[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function countersign(id: string) {
    setBusyId(id);
    setMessage("");
    setError("");
    try {
      const result = await countersignParticipationAgreement({ agreementId: id });
      if (!result.success) {
        setError(result.error ?? "The agreement could not be countersigned.");
        return;
      }
      setMessage("Agreement executed and the execution certificate recorded.");
      router.refresh();
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="rounded-xl border border-line bg-white p-5" data-testid="platform-countersign">
      <h2 className="text-base font-semibold text-ink-deep">Agreements awaiting BloomCore signature</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Executed by a platform administrator using BloomCore&rsquo;s configured authorised signatory.
        No DPO or DPS countersignature is required.
      </p>
      {message && <div className="mt-3"><Notice type="success">{message}</Notice></div>}
      {error && <div className="mt-3"><Notice type="error">{error}</Notice></div>}
      {agreements.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No accepted agreement is awaiting countersignature.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="py-2 pr-4">Business</th>
                <th className="py-2 pr-4">Instrument</th>
                <th className="py-2 pr-4">Version</th>
                <th className="py-2 pr-4">Accepted by</th>
                <th className="py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((agreement) => (
                <tr key={agreement.id} className="border-b border-line/60 align-top">
                  <td className="py-2 pr-4 font-medium text-ink-deep">{agreement.tenantName}</td>
                  <td className="py-2 pr-4">{agreement.type.replaceAll("_", " ")}</td>
                  <td className="py-2 pr-4">{agreement.version}</td>
                  <td className="py-2 pr-4">
                    {agreement.signatoryName}
                    <span className="block text-xs text-ink-muted">
                      {agreement.acceptedAt ? agreement.acceptedAt.slice(0, 10) : "date not recorded"}
                    </span>
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      disabled={Boolean(busyId)}
                      onClick={() => void countersign(agreement.id)}
                    >
                      {busyId === agreement.id ? "Signing…" : "Countersign"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
