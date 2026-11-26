"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Download,
  MapPinned,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  assignAssociationRole,
  createAssociation,
  createAssociationZone,
  getAssociationGovernance,
  recordAssociationConsent,
  revokeAssociationRole,
  withdrawAssociationConsent,
  type AssociationGovernanceView,
} from "@/lib/actions/association-governance.actions";
import {
  ASSOCIATION_CONSENT_LABELS,
  ASSOCIATION_GOVERNANCE_NOTE,
  ASSOCIATION_ROLES,
  ASSOCIATION_ROLE_LABELS,
  type AssociationConsentType,
  type AssociationRole,
} from "@/lib/association-governance";

/**
 * Association structure, roles and governance.
 *
 * The registers below this panel are administrative; this one records who an
 * association is, how it is divided, who may see it, and what consent exists.
 * Nothing here reaches a member business's money.
 */
export default function AssociationGovernancePanel() {
  const [view, setView] = useState<AssociationGovernanceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [associationCode, setAssociationCode] = useState("");
  const [associationName, setAssociationName] = useState("");
  const [associationRegion, setAssociationRegion] = useState("");

  const [zoneAssociationId, setZoneAssociationId] = useState("");
  const [zoneCode, setZoneCode] = useState("");
  const [zoneName, setZoneName] = useState("");
  const [zoneParentId, setZoneParentId] = useState("");

  const [roleAssociationId, setRoleAssociationId] = useState("");
  const [roleUserId, setRoleUserId] = useState("");
  const [roleValue, setRoleValue] = useState<AssociationRole>("zone_officer");

  const [consentAssociationId, setConsentAssociationId] = useState("");
  const [consentType, setConsentType] =
    useState<AssociationConsentType>("data_sharing");
  const [consentDocument, setConsentDocument] = useState("");
  const [consentExpiry, setConsentExpiry] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await getAssociationGovernance();
      if (!result.success || !result.data) {
        setError(result.error ?? "Association governance could not be loaded.");
      } else {
        setView(result.data);
        setZoneAssociationId((current) => current || result.data!.associations[0]?.id || "");
        setRoleAssociationId((current) => current || result.data!.associations[0]?.id || "");
        setConsentAssociationId((current) => current || result.data!.associations[0]?.id || "");
      }
    } catch {
      setError("Association governance could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await fn();
    if (!result.success) setError(result.error ?? "That action could not be completed.");
    else {
      setSuccess(message);
      await load();
    }
    setBusy(false);
  }

  if (loading && !view) {
    return <p className="text-sm text-slate-500">Loading association governance…</p>;
  }

  return (
    <section className="space-y-4" aria-labelledby="association-governance">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="association-governance" className="text-lg font-semibold text-slate-900">
            Association structure and governance
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">{ASSOCIATION_GOVERNANCE_NOTE}</p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </header>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2">
        {view?.associations.length ? (
          view.associations.map((association) => (
            <article key={association.id} className="card p-4">
              <div className="flex items-start gap-2">
                <Building2 size={16} className="mt-0.5 text-brand-700" aria-hidden />
                <div>
                  <p className="font-semibold text-slate-900">{association.name}</p>
                  <p className="font-mono text-[11px] text-slate-500">{association.code}</p>
                </div>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <dt className="text-slate-500">Members</dt>
                  <dd className="font-semibold">{association.members}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Zones</dt>
                  <dd className="font-semibold">{association.zones}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Live consents</dt>
                  <dd className="font-semibold">{association.activeConsents}</dd>
                </div>
              </dl>
              <p className="mt-2 text-[11px] text-slate-500">
                {association.region ?? "No region"}
                {association.charterVersion ? ` · charter ${association.charterVersion}` : ""}
              </p>
            </article>
          ))
        ) : (
          <p className="card p-4 text-sm text-slate-500">No association is registered yet.</p>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {view?.canManageGovernance && (
          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  createAssociation({
                    code: associationCode,
                    name: associationName,
                    region: associationRegion,
                  }),
                "Association created."
              );
            }}
          >
            <h3 className="text-sm font-semibold text-slate-900">Register an association</h3>
            <input
              value={associationCode}
              onChange={(event) => setAssociationCode(event.target.value)}
              placeholder="Code, e.g. MOMAG"
              className="input w-full"
              aria-label="Association code"
            />
            <input
              value={associationName}
              onChange={(event) => setAssociationName(event.target.value)}
              placeholder="Association name"
              className="input w-full"
              aria-label="Association name"
            />
            <input
              value={associationRegion}
              onChange={(event) => setAssociationRegion(event.target.value)}
              placeholder="Region (optional)"
              className="input w-full"
              aria-label="Association region"
            />
            <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
              <Plus size={14} aria-hidden /> Create association
            </button>
          </form>
        )}

        {view?.canManageGovernance && view.associations.length > 0 && (
          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  createAssociationZone({
                    associationId: zoneAssociationId,
                    code: zoneCode,
                    name: zoneName,
                    parentZoneId: zoneParentId || null,
                  }),
                "Zone added."
              );
            }}
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <MapPinned size={14} aria-hidden /> Add a zone or chapter
            </h3>
            <select
              value={zoneAssociationId}
              onChange={(event) => setZoneAssociationId(event.target.value)}
              className="input w-full"
              aria-label="Zone association"
            >
              {view.associations.map((association) => (
                <option key={association.id} value={association.id}>
                  {association.name}
                </option>
              ))}
            </select>
            <input
              value={zoneCode}
              onChange={(event) => setZoneCode(event.target.value)}
              placeholder="Zone code"
              className="input w-full"
              aria-label="Zone code"
            />
            <input
              value={zoneName}
              onChange={(event) => setZoneName(event.target.value)}
              placeholder="Zone name"
              className="input w-full"
              aria-label="Zone name"
            />
            <select
              value={zoneParentId}
              onChange={(event) => setZoneParentId(event.target.value)}
              className="input w-full"
              aria-label="Parent zone"
            >
              <option value="">No parent (top level)</option>
              {view.zones
                .filter((zone) => zone.associationId === zoneAssociationId)
                .map((zone) => (
                  <option key={zone.id} value={zone.id}>
                    {zone.name}
                  </option>
                ))}
            </select>
            <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
              Add zone
            </button>
          </form>
        )}
      </div>

      {view?.zones.length ? (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-900">Zones</h3>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">Code</th>
                <th className="py-1">Name</th>
                <th className="py-1">Parent</th>
                <th className="py-1">Region</th>
              </tr>
            </thead>
            <tbody>
              {view.zones.map((zone) => (
                <tr key={zone.id} className="border-t border-slate-100">
                  <td className="py-1 font-mono">{zone.code}</td>
                  <td className="py-1">{zone.name}</td>
                  <td className="py-1">{zone.parentName ?? "—"}</td>
                  <td className="py-1">{zone.region ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        {view?.canManageRoles && view.associations.length > 0 && (
          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  assignAssociationRole({
                    associationId: roleAssociationId,
                    userId: roleUserId,
                    role: roleValue,
                  }),
                "Role granted."
              );
            }}
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <UserPlus size={14} aria-hidden /> Give an association role
            </h3>
            <select
              value={roleAssociationId}
              onChange={(event) => setRoleAssociationId(event.target.value)}
              className="input w-full"
              aria-label="Role association"
            >
              {view.associations.map((association) => (
                <option key={association.id} value={association.id}>
                  {association.name}
                </option>
              ))}
            </select>
            <input
              value={roleUserId}
              onChange={(event) => setRoleUserId(event.target.value)}
              placeholder="User id of an administrator in this business"
              className="input w-full"
              aria-label="Person to grant"
            />
            <select
              value={roleValue}
              onChange={(event) => setRoleValue(event.target.value as AssociationRole)}
              className="input w-full"
              aria-label="Association role"
            >
              {ASSOCIATION_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ASSOCIATION_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
              Grant role
            </button>
          </form>
        )}

        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-900">Roles</h3>
          {view?.roles.length ? (
            <ul className="mt-2 space-y-2 text-xs">
              {view.roles.map((role) => (
                <li key={role.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-800">{role.userName}</span>
                  <span className="badge badge-blue">{role.roleLabel}</span>
                  {role.zoneName && <span className="text-slate-500">· {role.zoneName}</span>}
                  {role.revokedAt ? (
                    <span className="text-slate-400">revoked</span>
                  ) : (
                    view?.canManageRoles && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => revokeAssociationRole({ assignmentId: role.id }),
                            "Role revoked."
                          )
                        }
                        className="btn btn-secondary btn-xs"
                      >
                        Revoke
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-slate-500">No association roles yet.</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {view?.canManageGovernance && view.associations.length > 0 && (
          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  recordAssociationConsent({
                    associationId: consentAssociationId,
                    subjectType: consentType,
                    documentRef: consentDocument,
                    expiresAt: consentExpiry || undefined,
                  }),
                "Consent recorded."
              );
            }}
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldCheck size={14} aria-hidden /> Record a consent or agreement
            </h3>
            <select
              value={consentAssociationId}
              onChange={(event) => setConsentAssociationId(event.target.value)}
              className="input w-full"
              aria-label="Consent association"
            >
              {view.associations.map((association) => (
                <option key={association.id} value={association.id}>
                  {association.name}
                </option>
              ))}
            </select>
            <select
              value={consentType}
              onChange={(event) =>
                setConsentType(event.target.value as AssociationConsentType)
              }
              className="input w-full"
              aria-label="Consent type"
            >
              {Object.entries(ASSOCIATION_CONSENT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              value={consentDocument}
              onChange={(event) => setConsentDocument(event.target.value)}
              placeholder="Document reference (optional)"
              className="input w-full"
              aria-label="Consent document reference"
            />
            <label className="block text-xs font-medium text-slate-600">
              Expires (optional)
              <input
                type="date"
                value={consentExpiry}
                onChange={(event) => setConsentExpiry(event.target.value)}
                className="input mt-1 w-full"
                aria-label="Consent expiry"
              />
            </label>
            <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
              Record consent
            </button>
          </form>
        )}

        <div className="card space-y-2 p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Download size={14} aria-hidden /> Reports
          </h3>
          <p className="text-[11px] text-slate-500">
            Exports contain only this business&apos;s association rows.
          </p>
          <div className="flex flex-wrap gap-2">
            {(["members", "zones", "sponsorships", "training", "consent"] as const).map(
              (type) => (
                <a
                  key={type}
                  href={`/api/association/export?type=${type}`}
                  className="btn btn-secondary btn-xs"
                >
                  {type}
                </a>
              )
            )}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">Consent and agreements</h3>
          {view && view.lapsedConsents > 0 && (
            <span className="badge badge-yellow">{view.lapsedConsents} lapsed</span>
          )}
        </div>
        {view?.consents.length ? (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">Subject</th>
                <th className="py-1">Granted</th>
                <th className="py-1">Expires</th>
                <th className="py-1">State</th>
                <th className="py-1">Document</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {view.consents.map((consent) => (
                <tr key={consent.id} className="border-t border-slate-100">
                  <td className="py-1">{consent.subjectLabel}</td>
                  <td className="py-1">
                    {new Date(consent.grantedAt).toLocaleDateString("en-GB")}
                  </td>
                  <td className="py-1">
                    {consent.expiresAt
                      ? new Date(consent.expiresAt).toLocaleDateString("en-GB")
                      : "—"}
                  </td>
                  <td className="py-1">
                    {consent.withdrawnAt
                      ? "Withdrawn"
                      : consent.active
                        ? "Active"
                        : "Lapsed"}
                  </td>
                  <td className="py-1 font-mono">{consent.documentRef ?? "—"}</td>
                  <td className="py-1">
                    {consent.active && view.canManageGovernance && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              withdrawAssociationConsent({
                                consentId: consent.id,
                                note: "Withdrawn from the governance panel by an administrator.",
                              }),
                            "Consent withdrawn."
                          )
                        }
                        className="btn btn-secondary btn-xs"
                      >
                        Withdraw
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No consent recorded yet.</p>
        )}
      </div>
    </section>
  );
}
