"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, KeyRound, UserMinus, UserPlus } from "lucide-react";
import Modal from "@/components/ui/Modal";
import Notice from "@/components/ui/Notice";
import PasswordInput from "@/components/PasswordInput";
import { verifyPasswordAction } from "@/lib/actions/auth.actions";
import {
  assignStaffBranch,
  changeStaffRole,
  getStaffOffboardingReadiness,
  offboardStaff,
  reactivateStaff,
  revokeStaffBranchMembership,
  revokeStaffSessions,
  type StaffLifecycleOverview,
  type StaffLifecycleRow,
  type StaffOffboardingReadiness,
} from "@/lib/actions/susu-staff-lifecycle.actions";
import { exportStaffDirectoryCsv } from "@/lib/actions/susu-admin-export.actions";
import type { StepUpPurpose } from "@/lib/security/step-up";

type ActionKind = "offboard" | "reactivate" | "role" | "branch" | "revoke" | "sessions";

interface ActiveAction {
  kind: ActionKind;
  row: StaffLifecycleRow;
  membershipId?: string;
  membershipLabel?: string;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  worker: "Office staff",
  collector: "Susu collector",
};

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ActionButtons({
  row,
  canManageRoles,
  onOpen,
}: {
  row: StaffLifecycleRow;
  canManageRoles: boolean;
  onOpen: (action: ActiveAction) => void;
}) {
  if (row.status !== "active") {
    return (
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpen({ kind: "reactivate", row })}>
        <UserPlus size={12} aria-hidden /> Reactivate
      </button>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {canManageRoles && row.role !== "admin" && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpen({ kind: "role", row })}>
          Change role
        </button>
      )}
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpen({ kind: "branch", row })}>
        Branch access
      </button>
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpen({ kind: "sessions", row })}>
        <KeyRound size={12} aria-hidden /> Sign out
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs text-red-700"
        onClick={() => onOpen({ kind: "offboard", row })}
      >
        <UserMinus size={12} aria-hidden /> Offboard
      </button>
    </div>
  );
}

function StaffRows({
  rows,
  canManageRoles,
  onOpen,
}: {
  rows: StaffLifecycleRow[];
  canManageRoles: boolean;
  onOpen: (action: ActiveAction) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-control border border-line bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-brand-50 text-ink">
          <tr>
            <th className="p-3">Staff member</th>
            <th className="p-3">Role</th>
            <th className="p-3">Status</th>
            <th className="p-3">Branch access</th>
            <th className="p-3">Sessions</th>
            <th className="p-3">Outstanding</th>
            <th className="p-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const memberships = row.memberships.filter((membership) => membership.status === "active");
            const outstanding = row.blockers.reduce((total, blocker) => total + blocker.count, 0);
            return (
              <tr key={row.id} className="border-t border-line align-top">
                <td className="p-3">
                  <p className="font-medium text-ink">{row.fullName}</p>
                  <p className="text-xs text-ink-muted">{row.email}</p>
                  {row.isLastActiveAdmin && (
                    <p className="mt-1 text-xs text-amber-700">Last active administrator</p>
                  )}
                </td>
                <td className="p-3">{ROLE_LABELS[row.role] ?? row.role}</td>
                <td className="p-3">
                  <span className={row.status === "active" ? "badge badge-green" : "badge badge-gray"}>
                    {row.status}
                  </span>
                  {row.collectorStatus && row.collectorStatus !== "active" && (
                    <p className="mt-1 text-xs text-ink-muted">Collector: {row.collectorStatus}</p>
                  )}
                </td>
                <td className="p-3 text-xs">
                  {memberships.length === 0
                    ? "Company-wide"
                    : memberships.map((membership) => membership.locationName + " (" + membership.role + ")").join(", ")}
                </td>
                <td className="p-3">{row.activeSessions}</td>
                <td className="p-3">
                  {outstanding === 0 ? (
                    <span className="text-xs text-ink-muted">None</span>
                  ) : (
                    <span className="badge badge-yellow">{outstanding} item(s)</span>
                  )}
                </td>
                <td className="p-3">
                  <ActionButtons row={row} canManageRoles={canManageRoles} onOpen={onOpen} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function StaffLifecycleBoard({ initial }: { initial: StaffLifecycleOverview }) {
  const router = useRouter();
  const [action, setAction] = useState<ActiveAction | null>(null);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [role, setRole] = useState("worker");
  const [locationId, setLocationId] = useState(initial.branches[0]?.id ?? "");
  const [readiness, setReadiness] = useState<StaffOffboardingReadiness | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const activeRows = initial.rows.filter((row) => row.status === "active");
  const inactiveRows = initial.rows.filter((row) => row.status !== "active");

  function open(next: ActiveAction) {
    setAction(next);
    setError("");
    setSuccess("");
    setPassword("");
    setReason("");
    setRole(next.row.role === "collector" ? "worker" : "collector");
    setLocationId(initial.branches[0]?.id ?? "");
    setReadiness(null);
    if (next.kind === "offboard") {
      void getStaffOffboardingReadiness(next.row.id).then(setReadiness).catch(() => setReadiness(null));
    }
  }

  function close() {
    setAction(null);
    setPassword("");
    setReason("");
    setError("");
  }

  async function authorise(purpose: StepUpPurpose, targetType: string, targetId: string) {
    if (!password) {
      setError("Confirm your password to continue.");
      return null;
    }
    const stepUp = await verifyPasswordAction(password, { module: "admin", purpose, targetType, targetId });
    if (!stepUp.success) {
      setError(stepUp.error || "Could not confirm your password.");
      return null;
    }
    return (stepUp.data as { stepUpToken?: string } | undefined)?.stepUpToken ?? null;
  }

  async function submit() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      const kind = action.kind;
      if (kind === "offboard" || kind === "reactivate" || kind === "sessions") {
        const token = await authorise("staff.lifecycle", "user", action.row.id);
        if (!token) return;
        const result =
          kind === "offboard"
            ? await offboardStaff({ userId: action.row.id, reason, stepUpToken: token })
            : kind === "reactivate"
              ? await reactivateStaff({ userId: action.row.id, reason, stepUpToken: token })
              : await revokeStaffSessions({ userId: action.row.id, reason, stepUpToken: token });
        if (!result.success) {
          setError(result.error || "The action could not be completed.");
          return;
        }
        setSuccess(
          kind === "offboard"
            ? action.row.fullName + " was offboarded and signed out everywhere."
            : kind === "reactivate"
              ? action.row.fullName + " can sign in again."
              : action.row.fullName + " was signed out of every device."
        );
        close();
        router.refresh();
        return;
      }

      if (kind === "role") {
        const token = await authorise("staff.assignment", "user", action.row.id);
        if (!token) return;
        const result = await changeStaffRole({ userId: action.row.id, role, stepUpToken: token });
        if (!result.success) {
          setError(result.error || "The role could not be changed.");
          return;
        }
        setSuccess(action.row.fullName + " is now " + (ROLE_LABELS[role] ?? role) + ".");
        close();
        router.refresh();
        return;
      }

      if (kind === "branch") {
        const token = await authorise("staff.assignment", "user", action.row.id);
        if (!token) return;
        const result = await assignStaffBranch({ userId: action.row.id, locationId, role, stepUpToken: token });
        if (!result.success) {
          setError(result.error || "Branch access could not be granted.");
          return;
        }
        setSuccess("Branch access updated for " + action.row.fullName + ".");
        close();
        router.refresh();
        return;
      }

      if (kind === "revoke") {
        const token = await authorise("staff.assignment", "user", action.row.id);
        if (!token) return;
        const result = await revokeStaffBranchMembership({
          membershipId: action.membershipId ?? "",
          reason,
          stepUpToken: token,
        });
        if (!result.success) {
          setError(result.error || "Branch access could not be removed.");
          return;
        }
        setSuccess("Branch access removed for " + action.row.fullName + ".");
        close();
        router.refresh();
      }
    } catch {
      setError("The action could not be completed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function exportDirectory() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const token = await authorise("admin.export", "dataset", "staff_directory");
      if (!token) return;
      const result = await exportStaffDirectoryCsv({ stepUpToken: token });
      if (!result.success || !result.csv || !result.filename) {
        setError(result.error || "The directory could not be exported.");
        return;
      }
      downloadCsv(result.csv, result.filename);
      setSuccess("Staff directory exported. The export is recorded in the activity history.");
      setPassword("");
    } catch {
      setError("The directory could not be exported.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    action?.kind === "offboard"
      ? "Offboard " + action.row.fullName
      : action?.kind === "reactivate"
        ? "Reactivate " + action.row.fullName
        : action?.kind === "role"
          ? "Change role for " + action.row.fullName
          : action?.kind === "branch"
            ? "Branch access for " + action.row.fullName
            : action?.kind === "revoke"
              ? "Remove branch access"
              : action?.kind === "sessions"
                ? "Sign out " + action.row.fullName
                : "";

  return (
    <div className="space-y-6">
      {success && <Notice type="success" message={success}>{success}</Notice>}
      {!action && error && <Notice type="error" message={error}>{error}</Notice>}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-brand-900">Staff & access</h1>
            <Link href="/admin/staff" className="btn btn-secondary btn-sm">
              Add a staff member
            </Link>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Offboarding disables the account, revokes every session, removes branch access and stops
            collections. It refuses while the person still holds live responsibilities. Status is
            never deleted, so history stays attributable.
          </p>
        </div>
        <div className="w-64 space-y-2 rounded-control border border-line bg-white p-3">
          <label htmlFor="directory-password" className="block text-xs font-medium text-ink">
            Confirm your password to export
          </label>
          <PasswordInput
            id="directory-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <button type="button" onClick={exportDirectory} disabled={busy} className="btn btn-secondary btn-sm w-full">
            <Download size={14} aria-hidden /> Export staff directory
          </button>
        </div>
      </div>

      {!initial.companyWideActor && (
        <p className="rounded-control border border-brand-200 bg-brand-50 px-4 py-2 text-sm text-ink">
          You see staff in your branches. Role changes and company-wide visibility need a
          company-wide administrator.
        </p>
      )}

      <StaffRows rows={activeRows} canManageRoles={initial.canManageRoles} onOpen={open} />

      {inactiveRows.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-base font-semibold text-brand-900">Offboarded staff</h2>
          <StaffRows rows={inactiveRows} canManageRoles={initial.canManageRoles} onOpen={open} />
        </div>
      )}

      <Modal
        open={Boolean(action)}
        onClose={close}
        title={title}
        size="md"
        footer={
          <>
            <button type="button" onClick={close} className="btn btn-secondary btn-sm" disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className={action?.kind === "offboard" ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}
              disabled={busy}
            >
              {busy ? "Working…" : action?.kind === "offboard" ? "Offboard staff member" : "Confirm"}
            </button>
          </>
        }
      >
        {action && (
          <div className="space-y-4">
            {error && <Notice type="error" message={error}>{error}</Notice>}

            {action.kind === "offboard" && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  This signs the person out on every device and removes their branch access. Their
                  historical records keep their name.
                </p>
                {readiness ? (
                  <div className="rounded-lg border border-slate-200 p-3 text-sm">
                    <p className="font-medium text-slate-900">Before offboarding</p>
                    {readiness.ready ? (
                      <p className="mt-1 text-emerald-700">Nothing outstanding. The account can be offboarded.</p>
                    ) : (
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
                        {readiness.blockers.map((blocker) => (
                          <li key={blocker.key}>
                            <span className="font-medium">{blocker.label}</span> ({blocker.count}) —{" "}
                            {blocker.resolution}
                            {blocker.samples.length > 0 ? " e.g. " + blocker.samples.join(", ") : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {readiness.autoHandled.length > 0 && (
                      <p className="mt-2 text-xs text-slate-500">
                        Handled automatically:{" "}
                        {readiness.autoHandled.map((item) => item.label + " (" + item.count + ")").join(", ")}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Checking outstanding responsibilities…</p>
                )}
              </div>
            )}

            {action.kind === "role" && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">New role</span>
                <select value={role} onChange={(event) => setRole(event.target.value)} className="w-full">
                  <option value="worker">Office staff</option>
                  <option value="collector">Susu collector</option>
                </select>
                <span className="mt-1 block text-xs text-slate-500">
                  Administrator accounts are provisioned by platform support, not here.
                </span>
              </label>
            )}

            {action.kind === "branch" && (
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-700">Branch</span>
                  <select value={locationId} onChange={(event) => setLocationId(event.target.value)} className="w-full">
                    {initial.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-slate-700">Role in this branch</span>
                  <select value={role} onChange={(event) => setRole(event.target.value)} className="w-full">
                    <option value="branch_manager">Branch manager</option>
                    {initial.canGrantFinance && <option value="finance">Finance</option>}
                  </select>
                </label>
                {action.row.memberships.filter((membership) => membership.status === "active").length > 0 && (
                  <div className="rounded-lg border border-slate-200 p-3">
                    <p className="text-sm font-medium text-slate-900">Current access</p>
                    <ul className="mt-2 space-y-2">
                      {action.row.memberships
                        .filter((membership) => membership.status === "active")
                        .map((membership) => (
                          <li key={membership.id} className="flex items-center justify-between gap-2 text-sm">
                            <span>
                              {membership.locationName} · {membership.role}
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-xs"
                              onClick={() =>
                                setAction({
                                  kind: "revoke",
                                  row: action.row,
                                  membershipId: membership.id,
                                  membershipLabel: membership.locationName + " (" + membership.role + ")",
                                })
                              }
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                    </ul>
                    <p className="mt-2 text-xs text-slate-500">
                      Removing access requires its own reason and password confirmation.
                    </p>
                  </div>
                )}
              </div>
            )}

            {action.kind === "revoke" && (
              <p className="text-sm text-slate-600">
                Remove {action.membershipLabel} from {action.row.fullName}? Other branch access is kept.
              </p>
            )}

            {(action.kind === "offboard" ||
              action.kind === "reactivate" ||
              action.kind === "revoke" ||
              action.kind === "sessions" ||
              action.kind === "branch") && (
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">Reason</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  maxLength={500}
                  className="w-full"
                  placeholder="Recorded in the activity history."
                />
              </label>
            )}

            <div>
              <label htmlFor="staff-action-password" className="mb-1 block text-sm font-medium text-slate-700">
                Confirm your password
              </label>
              <PasswordInput
                id="staff-action-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
            {action.kind === "offboard" && readiness && !readiness.ready && (
              <p className="text-xs text-slate-500">
                Offboarding is blocked until the responsibilities above are cleared.
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
