"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, GraduationCap, Handshake, Plus, RefreshCw } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import AssociationGovernancePanel from "@/components/AssociationGovernancePanel";
import { SponsorshipPanel } from "@/components/SponsorshipPanel";
import TrainingPanel from "@/components/TrainingPanel";
import { StatCard } from "@/components/ui/DataDisplay";
import {
  createAssociationMember,
  createAssociationSponsorship,
  createAssociationTraining,
  getAssociationDashboard,
  updateAssociationMemberStatus,
  updateAssociationSponsorshipStatus,
  type AssociationDashboard,
} from "@/lib/actions/association.actions";
import {
  ASSOCIATION_MEMBER_STATUSES,
  ASSOCIATION_MEMBER_STATUS_LABELS,
  ASSOCIATION_SPONSORSHIP_STATUSES,
  ASSOCIATION_SPONSORSHIP_STATUS_LABELS,
  ASSOCIATION_TRAINING_STATUSES,
  ASSOCIATION_TRAINING_STATUS_LABELS,
} from "@/lib/association";

function fmt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AssociationPage() {
  const [data, setData] = useState<AssociationDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [member, setMember] = useState({
    memberCode: "",
    businessName: "",
    contactName: "",
    phone: "",
    email: "",
    region: "",
    status: "active",
    joinedAt: today(),
  });
  const [sponsorship, setSponsorship] = useState({
    memberId: "",
    sponsorName: "",
    planCode: "",
    amount: "",
    status: "pledged",
    startDate: today(),
    endDate: "",
    reference: "",
  });
  const [training, setTraining] = useState({
    memberId: "",
    title: "",
    provider: "",
    status: "completed",
    completedAt: today(),
    expiresAt: "",
    certificateReference: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getAssociationDashboard();
      setData(result);
      setSponsorship((current) => ({
        ...current,
        memberId: current.memberId || result.members[0]?.id || "",
      }));
      setTraining((current) => ({
        ...current,
        memberId: current.memberId || result.members[0]?.id || "",
      }));
    } catch {
      setError("The association register could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<{ success: boolean; error?: string }>, message: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await action();
      if (!result.success) {
        setError(result.error ?? "The record could not be saved.");
        return;
      }
      setSuccess(message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    await run(
      () => createAssociationMember(member),
      "Member registered. No subscription or payment was created."
    );
    setMember((current) => ({
      ...current,
      memberCode: "",
      businessName: "",
      contactName: "",
      phone: "",
      email: "",
      region: "",
    }));
  }

  async function addSponsorship() {
    await run(
      () =>
        createAssociationSponsorship({
          ...sponsorship,
          amount: Number(sponsorship.amount || 0),
          endDate: sponsorship.endDate || undefined,
          planCode: sponsorship.planCode || undefined,
          reference: sponsorship.reference || undefined,
        }),
      "Sponsorship recorded. This is an agreement record, not a payment."
    );
    setSponsorship((current) => ({
      ...current,
      sponsorName: "",
      planCode: "",
      amount: "",
      reference: "",
    }));
  }

  async function addTraining() {
    await run(
      () =>
        createAssociationTraining({
          ...training,
          provider: training.provider || undefined,
          expiresAt: training.expiresAt || undefined,
          certificateReference: training.certificateReference || undefined,
        }),
      "Training record saved."
    );
    setTraining((current) => ({
      ...current,
      title: "",
      provider: "",
      certificateReference: "",
    }));
  }

  if (loading && !data) return <p className="text-sm text-slate-500">Loading association register…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Association register</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Membership, sponsored packages and training records for this business
            or association. These are administrative records. A sponsorship never
            charges or pays anyone, and a training record does not grant a licence.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary" disabled={busy}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      {data && (
        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <StatCard label="Members" value={data.counts.members} />
          <StatCard label="Active members" value={data.counts.activeMembers} />
          <StatCard label="Active sponsorships" value={data.counts.activeSponsorships} />
          <StatCard
            label="Sponsored value"
            value={<CediAmount amount={data.counts.activeSponsorshipValue} />}
          />
          <StatCard label="Completed training" value={data.counts.completedTrainings} />
          <StatCard
            label="Training expiring in 90 days"
            value={data.counts.expiringTrainings}
            tone="warning"
          />
        </section>
      )}

      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Building2 size={15} aria-hidden /> Register a member
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Member code">
            <input value={member.memberCode} onChange={(e) => setMember({ ...member, memberCode: e.target.value })} maxLength={30} placeholder="MOM-001" />
          </Field>
          <Field label="Business name">
            <input value={member.businessName} onChange={(e) => setMember({ ...member, businessName: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Contact person">
            <input value={member.contactName} onChange={(e) => setMember({ ...member, contactName: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Phone">
            <input value={member.phone} onChange={(e) => setMember({ ...member, phone: e.target.value })} maxLength={30} placeholder="+233..." />
          </Field>
          <Field label="Email (optional)">
            <input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} maxLength={160} />
          </Field>
          <Field label="Region (optional)">
            <input value={member.region} onChange={(e) => setMember({ ...member, region: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Status">
            <select value={member.status} onChange={(e) => setMember({ ...member, status: e.target.value })}>
              {ASSOCIATION_MEMBER_STATUSES.map((status) => (
                <option key={status} value={status}>{ASSOCIATION_MEMBER_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </Field>
          <Field label="Joined">
            <input type="date" value={member.joinedAt} onChange={(e) => setMember({ ...member, joinedAt: e.target.value })} />
          </Field>
        </div>
        <button type="button" className="btn btn-primary mt-3" onClick={() => void addMember()} disabled={busy}>
          <Plus size={15} aria-hidden /> Register member
        </button>
      </section>

      {data && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-bold text-slate-900">Members ({data.members.length})</h2>
          </div>
          {data.members.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No association members yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Business</th><th>Contact</th><th>Region</th>
                    <th>Joined</th><th>Sponsorship</th><th>Training</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((row) => (
                    <tr key={row.id}>
                      <td className="font-mono text-xs">{row.memberCode}</td>
                      <td className="text-xs font-medium">{row.businessName}</td>
                      <td className="text-xs">{row.contactName}<span className="block text-slate-400">{row.phone ?? row.email ?? "—"}</span></td>
                      <td className="text-xs">{row.region ?? "—"}</td>
                      <td className="text-xs">{fmt(row.joinedAt)}</td>
                      <td className="text-xs">{row.sponsorshipCount}<span className="block text-slate-400"><CediAmount amount={row.activeSponsorshipValue} /> active</span></td>
                      <td className="text-xs">{row.trainingCount}</td>
                      <td className="text-xs">
                        <select
                          value={row.status}
                          disabled={busy}
                          onChange={(event) =>
                            void run(
                              () => updateAssociationMemberStatus({ memberId: row.id, status: event.target.value }),
                              "Member status updated."
                            )
                          }
                          className="input py-1"
                        >
                          {ASSOCIATION_MEMBER_STATUSES.map((status) => (
                            <option key={status} value={status}>{ASSOCIATION_MEMBER_STATUS_LABELS[status]}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Handshake size={15} aria-hidden /> Record a sponsored package
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          A record of who agreed to sponsor which member. It does not collect or
          release money and does not activate a paid subscription.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Member">
            <select value={sponsorship.memberId} onChange={(e) => setSponsorship({ ...sponsorship, memberId: e.target.value })}>
              <option value="">Choose a member</option>
              {data?.members.map((row) => <option key={row.id} value={row.id}>{row.businessName} ({row.memberCode})</option>)}
            </select>
          </Field>
          <Field label="Sponsor">
            <input value={sponsorship.sponsorName} onChange={(e) => setSponsorship({ ...sponsorship, sponsorName: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Plan code">
            <input value={sponsorship.planCode} onChange={(e) => setSponsorship({ ...sponsorship, planCode: e.target.value })} maxLength={40} placeholder="e.g. GROWTH" />
          </Field>
          <Field label="Amount (GH₵)">
            <input type="number" min="0" step="0.01" value={sponsorship.amount} onChange={(e) => setSponsorship({ ...sponsorship, amount: e.target.value })} />
          </Field>
          <Field label="Status">
            <select value={sponsorship.status} onChange={(e) => setSponsorship({ ...sponsorship, status: e.target.value })}>
              {ASSOCIATION_SPONSORSHIP_STATUSES.map((status) => (
                <option key={status} value={status}>{ASSOCIATION_SPONSORSHIP_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </Field>
          <Field label="Start date">
            <input type="date" value={sponsorship.startDate} onChange={(e) => setSponsorship({ ...sponsorship, startDate: e.target.value })} />
          </Field>
          <Field label="End date (optional)">
            <input type="date" value={sponsorship.endDate} onChange={(e) => setSponsorship({ ...sponsorship, endDate: e.target.value })} />
          </Field>
          <Field label="Reference (optional)">
            <input value={sponsorship.reference} onChange={(e) => setSponsorship({ ...sponsorship, reference: e.target.value })} maxLength={64} />
          </Field>
        </div>
        <button type="button" className="btn btn-primary mt-3" onClick={() => void addSponsorship()} disabled={busy || !sponsorship.memberId}>
          <Plus size={15} aria-hidden /> Record sponsorship
        </button>
      </section>

      {data && data.sponsorships.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-bold text-slate-900">Sponsorships</h2></div>
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Member</th><th>Sponsor</th><th>Plan</th><th>Amount</th><th>Period</th><th>Reference</th><th>Status</th></tr></thead>
              <tbody>
                {data.sponsorships.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs font-medium">{row.memberName}</td>
                    <td className="text-xs">{row.sponsorName}</td>
                    <td className="text-xs">{row.planCode ?? "—"}</td>
                    <td className="text-xs tnum"><CediAmount amount={row.amount} /></td>
                    <td className="text-xs">{fmt(row.startDate)} → {fmt(row.endDate)}</td>
                    <td className="font-mono text-xs">{row.reference ?? "—"}</td>
                    <td className="text-xs">
                      <select
                        value={row.status}
                        disabled={busy}
                        onChange={(event) =>
                          void run(
                            () => updateAssociationSponsorshipStatus({ sponsorshipId: row.id, status: event.target.value }),
                            "Sponsorship status updated."
                          )
                        }
                        className="input py-1"
                      >
                        {ASSOCIATION_SPONSORSHIP_STATUSES.map((status) => (
                          <option key={status} value={status}>{ASSOCIATION_SPONSORSHIP_STATUS_LABELS[status]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <GraduationCap size={15} aria-hidden /> Record training
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Member">
            <select value={training.memberId} onChange={(e) => setTraining({ ...training, memberId: e.target.value })}>
              <option value="">Choose a member</option>
              {data?.members.map((row) => <option key={row.id} value={row.id}>{row.businessName} ({row.memberCode})</option>)}
            </select>
          </Field>
          <Field label="Training title">
            <input value={training.title} onChange={(e) => setTraining({ ...training, title: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Provider (optional)">
            <input value={training.provider} onChange={(e) => setTraining({ ...training, provider: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Status">
            <select value={training.status} onChange={(e) => setTraining({ ...training, status: e.target.value })}>
              {ASSOCIATION_TRAINING_STATUSES.map((status) => (
                <option key={status} value={status}>{ASSOCIATION_TRAINING_STATUS_LABELS[status]}</option>
              ))}
            </select>
          </Field>
          <Field label="Completed">
            <input type="date" value={training.completedAt} onChange={(e) => setTraining({ ...training, completedAt: e.target.value })} />
          </Field>
          <Field label="Expires (optional)">
            <input type="date" value={training.expiresAt} onChange={(e) => setTraining({ ...training, expiresAt: e.target.value })} />
          </Field>
          <Field label="Certificate reference (optional)">
            <input value={training.certificateReference} onChange={(e) => setTraining({ ...training, certificateReference: e.target.value })} maxLength={120} />
          </Field>
        </div>
        <button type="button" className="btn btn-primary mt-3" onClick={() => void addTraining()} disabled={busy || !training.memberId}>
          <Plus size={15} aria-hidden /> Record training
        </button>
      </section>

      {data && data.trainings.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-bold text-slate-900">Training records</h2></div>
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Member</th><th>Training</th><th>Provider</th><th>Completed</th><th>Expires</th><th>Certificate</th><th>Status</th></tr></thead>
              <tbody>
                {data.trainings.map((row) => (
                  <tr key={row.id}>
                    <td className="text-xs font-medium">{row.memberName}</td>
                    <td className="text-xs">{row.title}</td>
                    <td className="text-xs">{row.provider ?? "—"}</td>
                    <td className="text-xs">{fmt(row.completedAt)}</td>
                    <td className="text-xs">{fmt(row.expiresAt)}</td>
                    <td className="font-mono text-xs">{row.certificateReference ?? "—"}</td>
                    <td className="text-xs">{row.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AssociationGovernancePanel />

      <SponsorshipPanel
        members={(data?.members ?? []).map((row) => ({
          id: row.id,
          label: `${row.businessName} (${row.memberCode})`,
        }))}
      />

      <TrainingPanel />

      <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
        Association records are internal. A sponsorship is not a payment, a
        membership does not create a subscription, and training completion does
        not certify anyone with a regulator.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-slate-700">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
