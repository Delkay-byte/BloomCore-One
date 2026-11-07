"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Power,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
} from "lucide-react";
import { setZeliAvailability } from "@/lib/actions/zeli-availability.actions";
import {
  clearZeliProviderEmergencyStop,
  emergencyDisableZeliProvider,
  runDeepSeekConnectionTest,
  setTenantZeliAiAuthorization,
  setZeliProviderMode,
  setZeliTeamTesterAccess,
  type ProviderActionResponse,
} from "@/lib/actions/zeli-provider.actions";
import { formatDateTime } from "@/lib/utils";

interface AvailabilityState {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedById: string | null;
  source: string;
}

interface ProviderState {
  control: {
    mode: string;
    enabled: boolean;
    emergencyDisabled: boolean;
    reason: string | null;
    updatedAt?: Date | string;
  };
  policy: {
    state: string;
    allowed: boolean;
    reason: string;
    credentialConfigured: boolean;
    codeApprovalPresent: boolean;
    privacyVersionPresent: boolean;
    approvalReferencePresent: boolean;
    tenantAuthorized: boolean;
  };
  message: string;
  productionCodeApproved: boolean;
  teamCodeApproved: boolean;
  syntheticEnvAllowed: boolean;
  teamEnvAllowed: boolean;
  teamTenantCode: string;
  teamTenantId: string | null;
  teamTenantName: string | null;
  teamTenantAuthorized: boolean;
  teamDisclosureVersion: string;
  teamDisclosureMatched: boolean;
  teamTesters: Array<{
    id: string;
    userId: string;
    email: string | null;
    fullName: string | null;
    status: string;
    disclosureVersion: string | null;
    disclosureAcceptedAt: string | null;
    reason: string;
    updatedAt: string;
  }>;
  teamMembers: Array<{
    id: string;
    email: string;
    fullName: string;
    role: string;
  }>;
  model: string;
  usage24h: { total: number; denied: number; successes: number; failures: number };
  usageTotals: {
    total: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastRequestAt: string | null;
  };
  tenants: Array<{ id: string; code: string; name: string }>;
  tenantAuthorizations: Array<{
    tenantId: string;
    tenantName: string;
    tenantCode: string;
    enabled: boolean;
    reason: string;
  }>;
}

const MODES = [
  {
    id: "disabled",
    label: "Disabled",
    summary: "No external provider processing. Zeli remains available locally.",
    data: "No external data.",
  },
  {
    id: "synthetic",
    label: "Synthetic testing",
    summary: "Only the fixed synthetic insight probe. Probes are not conversations.",
    data: "A fixed fake package; no tenant records.",
  },
  {
    id: "team_testing",
    label: "Team Testing",
    summary:
      "Genuine DeepSeek conversations for authorised team members, using synthetic business fixtures.",
    data: "Sanitised team messages and a fixed fictional scenario. No live records.",
  },
  {
    id: "approved",
    label: "Approved Production",
    summary:
      "Aggregate-only production processing. Only available after every production approval gate is genuinely satisfied.",
    data: "Approved aggregate packages only.",
  },
] as const;

export default function ZeliAdminControlCentre({
  availability,
  updatedByName,
  state,
}: {
  availability: AvailabilityState;
  updatedByName: string | null;
  state: ProviderState;
}) {
  const router = useRouter();
  const [availabilityReason, setAvailabilityReason] = useState("");
  const [aiReason, setAiReason] = useState("");
  const [probeReason, setProbeReason] = useState("");
  const [accessReason, setAccessReason] = useState("");
  const [selectedMode, setSelectedMode] = useState<string>(state.control.mode);
  const [selectedMember, setSelectedMember] = useState<string>(
    state.teamMembers[0]?.id ?? ""
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [probe, setProbe] = useState<{
    latencyMs: number;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    response: string;
  } | null>(null);

  const activeTesters = useMemo(
    () => state.teamTesters.filter((row) => row.status === "active"),
    [state.teamTesters]
  );
  const testerByUser = useMemo(
    () => new Map(state.teamTesters.map((row) => [row.userId, row])),
    [state.teamTesters]
  );

  function clearMessages() {
    setError("");
    setNotice("");
  }

  async function run<T>(
    key: string,
    call: () => Promise<ProviderActionResponse<T>>,
    successMessage: string
  ) {
    clearMessages();
    setBusy(key);
    try {
      const result = await call();
      if (!result.success) {
        setError(result.error ?? "The change failed.");
        return false;
      }
      setNotice(successMessage);
      router.refresh();
      return true;
    } catch {
      setError("The change failed. Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function changeAvailability(enabled: boolean) {
    clearMessages();
    if (availabilityReason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters for the availability change.");
      return;
    }
    if (
      !window.confirm(
        enabled
          ? "Enable Zeli for every tenant? This does not enable external AI."
          : "Disable all tenant-facing Zeli features immediately? Data and subscriptions are preserved."
      )
    ) {
      return;
    }
    setBusy("availability");
    try {
      const result = await setZeliAvailability({
        enabled,
        reason: availabilityReason,
      });
      if (!result.success) {
        setError(result.error ?? "The availability change failed.");
        return;
      }
      setNotice(enabled ? "Zeli is now ON for tenants." : "Zeli is now OFF for tenants.");
      setAvailabilityReason("");
      router.refresh();
    } catch {
      setError("The availability change failed. The previous setting may still apply.");
    } finally {
      setBusy(null);
    }
  }

  async function applyMode() {
    clearMessages();
    if (aiReason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters for the AI mode change.");
      return;
    }
    const mode = selectedMode as "disabled" | "synthetic" | "team_testing";
    if (mode === "team_testing") {
      if (
        !window.confirm(
          "Enable Team Testing? Authorised team members will be able to send messages to the live DeepSeek API. Synthetic data only; no live business records are sent."
        )
      ) {
        return;
      }
    }
    await run(
      "mode",
      () => setZeliProviderMode({ mode, reason: aiReason }),
      "AI operating mode updated."
    );
  }

  async function connectionTest() {
    clearMessages();
    if (probeReason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters for the connectivity test.");
      return;
    }
    setBusy("probe");
    try {
      const result = await runDeepSeekConnectionTest(probeReason);
      if (!result.success || !result.data) {
        setError(result.error ?? "The DeepSeek connectivity test failed.");
        return;
      }
      setProbe(result.data);
      setNotice(
        "DeepSeek connectivity test passed. This proves API connectivity only, not conversational routing."
      );
    } finally {
      setBusy(null);
    }
  }

  async function changeTester(enabled: boolean) {
    clearMessages();
    if (!state.teamTenantId || !selectedMember || accessReason.trim().length < 10) {
      setError("Choose a team member and enter a reason of at least 10 characters.");
      return;
    }
    if (
      !window.confirm(
        enabled
          ? "Grant this member access to live DeepSeek Team Testing? They must accept the synthetic-data disclosure before their first conversation."
          : "Revoke this member's Team Testing access immediately?"
      )
    ) {
      return;
    }
    await run(
      "tester",
      () =>
        setZeliTeamTesterAccess({
          tenantId: state.teamTenantId!,
          userId: selectedMember,
          enabled,
          reason: accessReason,
        }),
      enabled ? "Team Testing access granted." : "Team Testing access revoked."
    );
  }

  const gates = [
    {
      label: "Team Testing code approval",
      ok: state.teamCodeApproved,
      detail: state.teamCodeApproved
        ? "Reviewed team-testing transport is present."
        : "A reviewed code change is required.",
    },
    {
      label: "Team testing environment permission",
      ok: state.teamEnvAllowed,
      detail: state.teamEnvAllowed
        ? "ZELI_TEAM_TESTING_ALLOWED is true on this service."
        : "Set ZELI_TEAM_TESTING_ALLOWED=true on the maacash service.",
    },
    {
      label: "Team disclosure version",
      ok: state.teamDisclosureMatched,
      detail: state.teamDisclosureMatched
        ? `Disclosure ${state.teamDisclosureVersion} is recorded on the control.`
        : "Select Team Testing through the audited mode control to record the disclosure version.",
    },
    {
      label: "Team testing tenant",
      ok: Boolean(state.teamTenantId),
      detail: `Restricted to ${state.teamTenantCode}.`,
    },
    {
      label: "Tenant authorization",
      ok: state.teamTenantAuthorized,
      detail: state.teamTenantAuthorized
        ? "The restricted tenant is authorized."
        : "Authorize the tenant in the access section below.",
    },
    {
      label: "Team tester access",
      ok: activeTesters.length > 0,
      detail:
        activeTesters.length > 0
          ? `${activeTesters.length} active tester(s).`
          : "Grant access to at least one authorised team member.",
    },
    {
      label: "Emergency stop",
      ok: !state.control.emergencyDisabled,
      detail: state.control.emergencyDisabled
        ? "The emergency stop is ACTIVE. Clear it with a reason before enabling a mode."
        : "Cleared. Any activation still requires a deliberate mode change.",
    },
  ];

  return (
    <div className="space-y-5">
      {/* A — Global availability */}
      <section
        className={`card border-2 ${availability.enabled ? "border-emerald-200" : "border-red-300"}`}
        aria-label="Global Zeli availability"
        data-testid="zeli-availability"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              A · Tenant-facing product
            </p>
            <h2 className="mt-1 flex items-center gap-2 text-xl font-bold text-slate-900">
              {availability.enabled ? (
                <ShieldCheck size={20} className="text-emerald-700" aria-hidden />
              ) : (
                <ShieldOff size={20} className="text-red-700" aria-hidden />
              )}
              Global Zeli Availability
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              This switch turns Zeli on or off for every tenant. It does not enable
              DeepSeek and does not change subscriptions, payments or entitlements.
            </p>
          </div>
          <span
            className={`badge self-start text-sm ${availability.enabled ? "badge-green" : "badge-red"}`}
          >
            ZELI {availability.enabled ? "ON" : "OFF"}
          </span>
        </div>

        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <Info label="Current state" value={availability.enabled ? "ON — available to tenants" : "OFF — unavailable to tenants"} />
          <Info
            label="Last changed"
            value={
              availability.updatedAt
                ? `${formatDateTime(availability.updatedAt)}${updatedByName ? ` · ${updatedByName}` : ""}`
                : "No recorded change"
            }
          />
          <div className="sm:col-span-2">
            <Info label="Reason" value={availability.reason ?? "—"} />
          </div>
        </dl>

        <label className="mt-4 block text-sm">
          <span className="font-medium text-slate-700">
            Reason for availability change (required)
          </span>
          <textarea
            className="mt-1 w-full"
            rows={2}
            maxLength={500}
            value={availabilityReason}
            onChange={(event) => setAvailabilityReason(event.target.value)}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null || availability.enabled}
            onClick={() => changeAvailability(true)}
          >
            {busy === "availability" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Power size={13} aria-hidden />}
            Enable Zeli
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null || !availability.enabled}
            onClick={() => changeAvailability(false)}
          >
            <Power size={13} aria-hidden /> Disable Zeli
          </button>
        </div>
      </section>

      {/* B — AI operating mode */}
      <section className="card bg-white" aria-label="AI operating mode" data-testid="provider-control">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          B · External AI
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold text-slate-900">
              <Sparkles size={20} className="text-brand-700" aria-hidden />
              AI Operating Mode
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Select exactly one mode. The server persists and enforces it on every
              request; the browser cannot grant access.
            </p>
          </div>
          <span className={`badge self-start ${state.control.emergencyDisabled ? "badge-red" : "badge-green"}`}>
            {state.control.mode === "team_testing"
              ? "TEAM TESTING"
              : state.control.mode.toUpperCase()}
          </span>
        </div>

        <fieldset className="mt-4 grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Choose the AI operating mode</legend>
          {MODES.map((mode) => {
            const unavailable =
              (mode.id === "approved" && !state.productionCodeApproved) ||
              (mode.id === "synthetic" && !state.syntheticEnvAllowed) ||
              (mode.id === "team_testing" &&
                (!state.teamEnvAllowed || !state.teamCodeApproved));
            return (
              <label
                key={mode.id}
                className={`cursor-pointer rounded-xl border p-3 text-sm ${
                  selectedMode === mode.id
                    ? "border-brand-500 bg-brand-50"
                    : "border-slate-200 bg-white"
                } ${unavailable ? "opacity-60" : ""}`}
              >
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="zeli-ai-mode"
                    value={mode.id}
                    checked={selectedMode === mode.id}
                    onChange={() => setSelectedMode(mode.id)}
                    disabled={unavailable}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-semibold text-slate-900">
                      {mode.label}
                    </span>
                    <span className="mt-1 block text-xs text-slate-600">
                      {mode.summary}
                    </span>
                    <span className="mt-1 block text-xs text-slate-500">
                      Data: {mode.data}
                    </span>
                    {unavailable && (
                      <span className="mt-1 block text-xs font-medium text-amber-800">
                        Unavailable:{" "}
                        {mode.id === "approved"
                          ? "production code approval is locked."
                          : mode.id === "synthetic"
                            ? "synthetic environment permission is off."
                            : "team-testing code or environment permission is missing."}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Selected mode: <strong>{MODES.find((mode) => mode.id === selectedMode)?.label ?? state.control.mode}</strong>.
          Team Testing uses genuine DeepSeek API calls with synthetic business fixtures only.
          Approved Production remains separate and locked until every production gate is satisfied.
        </div>

        <label className="mt-3 block text-sm">
          <span className="font-medium text-slate-700">Reason for AI mode change</span>
          <textarea
            className="mt-1 w-full"
            rows={2}
            maxLength={500}
            value={aiReason}
            onChange={(event) => setAiReason(event.target.value)}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null || selectedMode === state.control.mode}
            onClick={applyMode}
          >
            {busy === "mode" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Power size={13} aria-hidden />}
            Apply selected mode
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => {
              setSelectedMode("disabled");
              setAiReason("Disable external AI and return Zeli to local operation.");
            }}
          >
            Prepare Disabled mode
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => {
              clearMessages();
              if (aiReason.trim().length < 10) {
                setError("Enter a reason of at least 10 characters.");
                return;
              }
              if (!window.confirm("Activate the emergency stop? All external AI calls stop immediately.")) return;
              void run(
                "emergency",
                () => emergencyDisableZeliProvider(aiReason),
                "Provider control updated."
              );
            }}
          >
            <ShieldOff size={13} aria-hidden /> Emergency stop
          </button>
          {state.control.emergencyDisabled && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={() => {
                clearMessages();
                if (aiReason.trim().length < 10) {
                  setError("Enter a reason of at least 10 characters.");
                  return;
                }
                if (!window.confirm("Clear the emergency stop? This does not enable any mode.")) return;
                void run(
                  "clear-stop",
                  () => clearZeliProviderEmergencyStop(aiReason),
                  "Provider control updated."
                );
              }}
            >
              <ShieldCheck size={13} aria-hidden /> Clear emergency stop
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The emergency stop is a latch. Changing mode never clears it.
        </p>
      </section>

      {/* C — Provider status */}
      <section className="card bg-white" aria-label="DeepSeek provider status">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          C · Provider
        </p>
        <h2 className="mt-1 text-xl font-bold text-slate-900">DeepSeek Provider Status</h2>
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Status label="Provider configured" ok={state.policy.state !== "disabled" || state.policy.credentialConfigured} yes="DeepSeek" no="Not configured" />
          <Status label="Credential present" ok={state.policy.credentialConfigured} yes="Present" no="Missing" />
          <Status label="Model configured" ok={Boolean(state.model)} yes={state.model} no="Missing" />
          <Status label="API connectivity" ok={Boolean(probe)} yes={probe ? `${probe.latencyMs} ms` : "Tested successfully"} no="Not tested in this session" />
          <Status label="Emergency stop" ok={!state.control.emergencyDisabled} yes="Cleared" no="ACTIVE" />
          <Status label="Last successful request" ok={Boolean(state.usageTotals.lastSuccessAt)} yes={state.usageTotals.lastSuccessAt ? formatDateTime(state.usageTotals.lastSuccessAt) : "—"} no="No success recorded" />
          <Status label="Last provider failure" ok={!state.usageTotals.lastFailureAt} yes="No failure recorded" no={state.usageTotals.lastFailureAt ? formatDateTime(state.usageTotals.lastFailureAt) : "—"} />
          <Info label="Requests (24h)" value={String(state.usage24h.total)} />
          <Info label="Success / failure (24h)" value={`${state.usage24h.successes} / ${state.usage24h.failures}`} />
          <Info label="Denied (24h)" value={String(state.usage24h.denied)} />
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-slate-700">Reason for connectivity test</span>
              <input
                className="mt-1 w-full"
                value={probeReason}
                maxLength={500}
                onChange={(event) => setProbeReason(event.target.value)}
                placeholder="Minimum 10 characters"
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy !== null || state.control.emergencyDisabled}
              onClick={connectionTest}
              title={
                state.control.emergencyDisabled
                  ? "Clear the emergency stop before testing the provider."
                  : "Send a harmless fixed prompt to the DeepSeek API."
              }
            >
              {busy === "probe" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
              Test DeepSeek Connection
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            This sends a harmless fixed prompt and proves API connectivity only. It
            does not prove conversational routing and sends no tenant data.
          </p>
          {probe && (
            <p className="mt-2 text-xs text-emerald-800">
              Connectivity OK · {probe.latencyMs} ms · {probe.model} · input{" "}
              {probe.inputTokens ?? "?"} / output {probe.outputTokens ?? "?"} tokens
            </p>
          )}
        </div>
      </section>

      {/* D — Safety and approval gates */}
      <section className="card bg-white" aria-label="Safety and approval gates">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          D · Safety
        </p>
        <h2 className="mt-1 text-xl font-bold text-slate-900">Safety and Approval Gates</h2>
        <dl className="mt-3 divide-y divide-slate-100">
          {gates.map((gate) => (
            <div key={gate.label} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div>
                <dt className="font-medium text-slate-800">{gate.label}</dt>
                <dd className="mt-0.5 text-xs text-slate-500">{gate.detail}</dd>
              </div>
              <span className={`badge flex-none ${gate.ok ? "badge-green" : "badge-red"}`}>
                {gate.ok ? "OK" : "ACTION NEEDED"}
              </span>
            </div>
          ))}
        </dl>

        <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium text-slate-700">
            <ChevronDown size={14} aria-hidden /> Approved Production gates (separate)
          </summary>
          <div className="mt-2 space-y-1 text-xs text-slate-600">
            <p>Code approval: <strong>{state.productionCodeApproved ? "Approved" : "Locked"}</strong></p>
            <p>Privacy policy version: <strong>{state.policy.privacyVersionPresent ? "Matched" : "Not matched"}</strong></p>
            <p>Approval reference: <strong>{state.policy.approvalReferencePresent ? "Present" : "Missing"}</strong></p>
            <p>Per-tenant authorization: <strong>{state.policy.tenantAuthorized ? "Authorized" : "Not authorized"}</strong></p>
            <p className="pt-1 text-amber-800">
              Approved Production stays locked while its reviewed code constant is false.
              Team Testing does not change that.
            </p>
          </div>
        </details>
      </section>

      {/* E — Team and tenant access */}
      <section className="card bg-white" aria-label="Team and tenant access">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          E · Access
        </p>
        <h2 className="mt-1 text-xl font-bold text-slate-900">Tenant and Team Access</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <Info label="Team testing tenant" value={`${state.teamTenantName ?? "Not found"} (${state.teamTenantCode})`} />
          <Info label="Tenant authorization" value={state.teamTenantAuthorized ? "Authorized" : "Not authorized"} />
          <Info label="Active team testers" value={String(activeTesters.length)} />
          <Info label="Disclosure version" value={state.teamDisclosureVersion} />
        </dl>

        {state.teamTesters.length > 0 && (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {state.teamTesters.map((tester) => (
              <li key={tester.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-slate-800">
                    {tester.fullName ?? tester.email ?? tester.userId}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {tester.email ?? "No email"} · {tester.status}
                    {tester.disclosureAcceptedAt
                      ? ` · disclosure accepted ${formatDateTime(tester.disclosureAcceptedAt)}`
                      : " · disclosure not accepted"}
                  </span>
                </span>
                <span className={`badge ${tester.status === "active" ? "badge-green" : "badge-gray"}`}>
                  {tester.status === "active" ? "ACTIVE" : "REVOKED"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr]">
          <label className="text-sm">
            <span className="font-medium text-slate-700">Authorised team member</span>
            <select
              className="mt-1 w-full"
              value={selectedMember}
              onChange={(event) => setSelectedMember(event.target.value)}
            >
              <option value="">Choose a member</option>
              {state.teamMembers.map((member) => {
                const existing = testerByUser.get(member.id);
                return (
                  <option key={member.id} value={member.id}>
                    {member.fullName} ({member.email}){existing ? ` — ${existing.status}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Reason (required)</span>
            <input
              className="mt-1 w-full"
              value={accessReason}
              maxLength={500}
              onChange={(event) => setAccessReason(event.target.value)}
              placeholder="Minimum 10 characters"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy !== null || !state.teamTenantId}
            onClick={() => changeTester(true)}
          >
            {busy === "tester" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
            Grant Team Testing access
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null || !state.teamTenantId}
            onClick={() => changeTester(false)}
          >
            Revoke access
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null || !state.teamTenantId || !state.teamTenantAuthorized}
            onClick={() =>
              void run(
                "tenant-auth",
                () =>
                  setTenantZeliAiAuthorization({
                    tenantId: state.teamTenantId!,
                    enabled: !state.teamTenantAuthorized,
                    reason:
                      accessReason.trim().length >= 10
                        ? accessReason
                        : "Authorize the restricted Team Testing tenant.",
                  }),
                state.teamTenantAuthorized
                  ? "Tenant authorization removed."
                  : "Tenant authorization recorded."
              )
            }
          >
            {state.teamTenantAuthorized ? "Remove tenant authorization" : "Authorize tenant"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Granting a member never enables external AI by itself. The member must also
          accept the disclosure in Zeli before the first DeepSeek conversation.
        </p>
      </section>

      {/* F — Usage and audit */}
      <section className="card bg-white" aria-label="Usage and audit">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          F · Evidence
        </p>
        <h2 className="mt-1 text-xl font-bold text-slate-900">Usage and Audit</h2>
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Info label="Total requests" value={String(state.usageTotals.total)} />
          <Info label="Successful (24h)" value={String(state.usage24h.successes)} />
          <Info label="Failed (24h)" value={String(state.usage24h.failures)} />
          <Info label="Denied (24h)" value={String(state.usage24h.denied)} />
          <Info label="Last request" value={state.usageTotals.lastRequestAt ? formatDateTime(state.usageTotals.lastRequestAt) : "—"} />
          <Info label="Last success" value={state.usageTotals.lastSuccessAt ? formatDateTime(state.usageTotals.lastSuccessAt) : "—"} />
          <Info label="Model" value={state.model} />
          <Info label="Prompt/response payloads" value="Never stored" />
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Usage rows store decisions, timing, token counts and hashed tenant/user
          references only. Prompts, responses, credentials and raw identifiers are not stored.
        </p>
        <Link href="/platform/audit" className="mt-3 inline-block text-sm font-medium text-brand-700 hover:text-brand-800">
          Open platform audit history →
        </Link>
      </section>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function Status({
  label,
  ok,
  yes,
  no,
}: {
  label: string;
  ok: boolean;
  yes: string;
  no: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 p-2">
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-0.5 text-sm font-medium text-slate-800">{ok ? yes : no}</p>
      </div>
      <span className={`badge flex-none ${ok ? "badge-green" : "badge-red"}`}>
        {ok ? "OK" : "CHECK"}
      </span>
    </div>
  );
}
