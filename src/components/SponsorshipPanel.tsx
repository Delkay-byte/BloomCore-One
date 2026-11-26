"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createSponsor,
  createSponsorshipAgreement,
  getSponsorshipOverview,
  recordSponsorshipCoverage,
  recordSponsorshipFunding,
  type SponsorshipOverview,
} from "@/lib/actions/sponsorship.actions";
import { SPONSORSHIP_DISCLAIMER, SPONSOR_KINDS, SPONSOR_KIND_LABELS } from "@/lib/sponsorship";

/**
 * Sponsor register, funding ledger and coverage.
 *
 * The screen never shows a sponsorship as "paid" on its own: it shows what was
 * agreed, what has actually been funded, and which periods that money covers.
 */
export function SponsorshipPanel({ members }: { members: Array<{ id: string; label: string }> }) {
  const [overview, setOverview] = useState<SponsorshipOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [sponsorName, setSponsorName] = useState("");
  const [sponsorKind, setSponsorKind] = useState<"individual" | "business" | "association">(
    "business"
  );
  const [sponsorCap, setSponsorCap] = useState("");

  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [sponsorId, setSponsorId] = useState("");
  const [planCode, setPlanCode] = useState("PRO");
  const [amount, setAmount] = useState("");

  const [fundingSponsorshipId, setFundingSponsorshipId] = useState("");
  const [fundingKind, setFundingKind] = useState<"allocation" | "release">("allocation");
  const [fundingAmount, setFundingAmount] = useState("");
  const [fundingReference, setFundingReference] = useState("");

  const [coverageSponsorshipId, setCoverageSponsorshipId] = useState("");
  const [coverageTenantId, setCoverageTenantId] = useState("");
  const [coverageMonths, setCoverageMonths] = useState("3");
  const [coverageAmount, setCoverageAmount] = useState("");

  async function load() {
    const result = await getSponsorshipOverview();
    if (result.success && result.data) {
      setOverview(result.data);
      setSponsorId((current) => current || (result.data!.sponsors[0]?.id ?? ""));
      setFundingSponsorshipId(
        (current) => current || (result.data!.sponsorships[0]?.id ?? "")
      );
      setCoverageSponsorshipId(
        (current) => current || (result.data!.sponsorships[0]?.id ?? "")
      );
    } else {
      setMessage({ tone: "error", text: result.error ?? "Could not load sponsorships." });
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<{ success: boolean; error?: string; data?: SponsorshipOverview }>, ok: string) {
    setBusy(true);
    setMessage(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) {
      setMessage({ tone: "error", text: result.error ?? "That did not work." });
      return;
    }
    if (result.data) setOverview(result.data);
    setMessage({ tone: "ok", text: ok });
  }

  const sponsorships = useMemo(() => overview?.sponsorships ?? [], [overview]);
  const selected = useMemo(
    () => sponsorships.find((row) => row.id === fundingSponsorshipId) ?? null,
    [sponsorships, fundingSponsorshipId]
  );

  return (
    <section className="card" style={{ display: "grid", gap: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 className="card-title">Sponsored subscriptions</h2>
          <p className="muted" style={{ margin: 0 }}>
            Who pays for a member&apos;s subscription, and what that money actually covers.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted">Funded, not yet assigned</div>
          <strong data-testid="sponsorship-unassigned">
            GHS {((overview?.unassignedPesewa ?? 0) / 100).toFixed(2)}
          </strong>
          <div className="muted" style={{ marginTop: 6 }}>
            Cover active now
          </div>
          <strong data-testid="sponsorship-covered">
            GHS {((overview?.coveredPesewa ?? 0) / 100).toFixed(2)}
          </strong>
        </div>
      </header>

      {message ? <div className={`notice ${message.tone === "ok" ? "" : "notice-danger"}`}>{message.text}</div> : null}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div>
          <label className="label" htmlFor="sponsor-name">
            Sponsor name
          </label>
          <input
            id="sponsor-name"
            className="input"
            value={sponsorName}
            onChange={(event) => setSponsorName(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="sponsor-kind">
            Kind
          </label>
          <select
            id="sponsor-kind"
            className="input"
            value={sponsorKind}
            onChange={(event) => setSponsorKind(event.target.value as typeof sponsorKind)}
          >
            {SPONSOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SPONSOR_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sponsor-cap">
            Yearly cap (GHS)
          </label>
          <input
            id="sponsor-cap"
            className="input"
            inputMode="decimal"
            value={sponsorCap}
            onChange={(event) => setSponsorCap(event.target.value)}
            placeholder="optional"
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="sponsor-create"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  createSponsor({
                    name: sponsorName,
                    kind: sponsorKind,
                    annualCapPesewa: sponsorCap ? Math.round(Number(sponsorCap) * 100) : null,
                  }),
                "Sponsor registered."
              )
            }
          >
            Register sponsor
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div>
          <label className="label" htmlFor="sponsor-member">
            Member
          </label>
          <select
            id="sponsor-member"
            className="input"
            value={memberId}
            onChange={(event) => setMemberId(event.target.value)}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sponsor-select">
            Sponsor
          </label>
          <select
            id="sponsor-select"
            className="input"
            value={sponsorId}
            onChange={(event) => setSponsorId(event.target.value)}
          >
            {(overview?.sponsors ?? []).map((sponsor) => (
              <option key={sponsor.id} value={sponsor.id}>
                {sponsor.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sponsor-plan">
            Plan code
          </label>
          <input
            id="sponsor-plan"
            className="input"
            value={planCode}
            onChange={(event) => setPlanCode(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="sponsor-amount">
            Agreed amount (GHS)
          </label>
          <input
            id="sponsor-amount"
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn"
            data-testid="sponsorship-create"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  createSponsorshipAgreement({
                    memberId,
                    sponsorId,
                    planCode,
                    amount: Number(amount),
                  }),
                "Sponsorship agreement recorded."
              )
            }
          >
            Record agreement
          </button>
        </div>
      </div>

      <div>
        <h3 className="card-title">Sponsorships</h3>
        {sponsorships.length === 0 ? (
          <p className="muted">No sponsorship has been agreed yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Sponsor</th>
                <th>Plan</th>
                <th>Agreed</th>
                <th>Funded</th>
                <th>Covered until</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sponsorships.map((row) => (
                <tr key={row.id} data-testid={`sponsorship-row-${row.memberCode}`}>
                  <td>
                    {row.memberName}
                    <div className="muted">{row.memberCode}</div>
                  </td>
                  <td>{row.sponsorName}</td>
                  <td>{row.planCode ?? "—"}</td>
                  <td>GHS {(row.agreedPesewa / 100).toFixed(2)}</td>
                  <td>
                    GHS {(row.netPesewa / 100).toFixed(2)}
                    {row.releasedPesewa > 0 ? (
                      <div className="muted">after GHS {(row.releasedPesewa / 100).toFixed(2)} released</div>
                    ) : null}
                  </td>
                  <td>
                    {row.coverageEndsAt
                      ? new Date(row.coverageEndsAt).toLocaleDateString()
                      : "not covered"}
                  </td>
                  <td>
                    <span className={row.status === "active" ? "pill pill-ok" : "pill"}>{row.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div>
          <label className="label" htmlFor="funding-sponsorship">
            Sponsorship
          </label>
          <select
            id="funding-sponsorship"
            className="input"
            value={fundingSponsorshipId}
            onChange={(event) => setFundingSponsorshipId(event.target.value)}
          >
            {sponsorships.map((row) => (
              <option key={row.id} value={row.id}>
                {row.memberCode} — {row.sponsorName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="funding-kind">
            Movement
          </label>
          <select
            id="funding-kind"
            className="input"
            value={fundingKind}
            onChange={(event) => setFundingKind(event.target.value as typeof fundingKind)}
          >
            <option value="allocation">Allocation (money in)</option>
            <option value="release">Release (money returned)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="funding-amount">
            Amount (GHS)
          </label>
          <input
            id="funding-amount"
            className="input"
            inputMode="decimal"
            value={fundingAmount}
            onChange={(event) => setFundingAmount(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="funding-reference">
            Reference
          </label>
          <input
            id="funding-reference"
            className="input"
            value={fundingReference}
            onChange={(event) => setFundingReference(event.target.value)}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn"
            data-testid="funding-record"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  recordSponsorshipFunding({
                    sponsorshipId: fundingSponsorshipId,
                    kind: fundingKind,
                    amount: Number(fundingAmount),
                    reference: fundingReference,
                  }),
                "Funding recorded."
              )
            }
          >
            Record money
          </button>
        </div>
      </div>
      {selected && selected.funding.length > 0 ? (
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
          {selected.funding.map((entry) => (
            <li key={entry.id}>
              {entry.kind === "release" ? "Released" : "Funded"} {entry.amountLabel} on{" "}
              {new Date(entry.fundedAt).toLocaleDateString()} · ref {entry.reference}
            </li>
          ))}
        </ul>
      ) : null}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <div>
          <label className="label" htmlFor="coverage-sponsorship">
            Sponsorship
          </label>
          <select
            id="coverage-sponsorship"
            className="input"
            value={coverageSponsorshipId}
            onChange={(event) => setCoverageSponsorshipId(event.target.value)}
          >
            {sponsorships.map((row) => (
              <option key={row.id} value={row.id}>
                {row.memberCode} — {row.sponsorName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="coverage-tenant">
            Covered business id
          </label>
          <input
            id="coverage-tenant"
            className="input"
            value={coverageTenantId}
            onChange={(event) => setCoverageTenantId(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="coverage-months">
            Months
          </label>
          <input
            id="coverage-months"
            className="input"
            inputMode="numeric"
            value={coverageMonths}
            onChange={(event) => setCoverageMonths(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="coverage-amount">
            Covered amount (GHS)
          </label>
          <input
            id="coverage-amount"
            className="input"
            inputMode="decimal"
            value={coverageAmount}
            onChange={(event) => setCoverageAmount(event.target.value)}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn"
            data-testid="coverage-record"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  recordSponsorshipCoverage({
                    sponsorshipId: coverageSponsorshipId,
                    subjectTenantId: coverageTenantId,
                    months: Number(coverageMonths),
                    amount: Number(coverageAmount),
                  }),
                "Coverage recorded for that business."
              )
            }
          >
            Assign cover
          </button>
        </div>
      </div>

      {overview && overview.sponsors.length > 0 ? (
        <div>
          <h3 className="card-title">Sponsors</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Sponsor</th>
                <th>Kind</th>
                <th>Committed this year</th>
                <th>Yearly cap</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {overview.sponsors.map((sponsor) => (
                <tr key={sponsor.id}>
                  <td>{sponsor.name}</td>
                  <td>{sponsor.kindLabel}</td>
                  <td>GHS {(sponsor.committedThisYearPesewa / 100).toFixed(2)}</td>
                  <td>
                    {sponsor.annualCapPesewa === null
                      ? "no cap"
                      : `GHS ${(sponsor.annualCapPesewa / 100).toFixed(2)}`}
                  </td>
                  <td>{sponsor.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="muted" style={{ margin: 0 }}>
        {SPONSORSHIP_DISCLAIMER}
      </p>
    </section>
  );
}
