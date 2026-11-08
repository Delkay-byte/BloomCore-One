"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Loader2,
  PlayCircle,
  Power,
  ShieldOff,
  ShieldCheck,
} from "lucide-react";
import { useConfirm } from "@/components/ui/useConfirm";
import {
  clearZeliProviderEmergencyStop,
  emergencyDisableZeliProvider,
  runSyntheticDeepSeekProbe,
  setTenantZeliAiAuthorization,
  setZeliProviderMode,
  type ProviderActionResponse,
} from "@/lib/actions/zeli-provider.actions";

interface ProviderState {
  control: { mode: string; enabled: boolean; emergencyDisabled: boolean; reason: string | null };
  policy: {
    state: string;
    allowed: boolean;
    reason: string;
    credentialConfigured: boolean;
    codeApprovalPresent: boolean;
    privacyVersionPresent: boolean;
    approvalReferencePresent: boolean;
  };
  message: string;
  productionCodeApproved: boolean;
  syntheticEnvAllowed: boolean;
  model: string;
  usage24h: { total: number; denied: number; successes: number; failures: number };
  tenants: Array<{ id: string; code: string; name: string }>;
  tenantAuthorizations: Array<{
    tenantId: string;
    tenantName: string;
    tenantCode: string;
    enabled: boolean;
    reason: string;
  }>;
}

export default function ProviderControlPanel({ state }: { state: ProviderState }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, confirmNode } = useConfirm();
  const [probe, setProbe] = useState<{ latencyMs: number; inputTokens: number | null; outputTokens: number | null } | null>(null);
  const [authTenant, setAuthTenant] = useState(state.tenants[0]?.id ?? "");
  const [authReason, setAuthReason] = useState("");

  async function apply(label: string, call: () => Promise<ProviderActionResponse<unknown>>) {
    setError("");
    setNotice("");
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    setBusy(label);
    try {
      const result = await call();
      if (!result.success) {
        setError(result.error ?? "The change failed.");
        return;
      }
      setNotice("Provider control updated.");
      router.refresh();
    } catch {
      setError("The change failed.");
    } finally {
      setBusy(null);
    }
  }

  async function probeProvider() {
    setError("");
    setNotice("");
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    setBusy("probe");
    try {
      const result = await runSyntheticDeepSeekProbe(reason);
      if (!result.success || !result.data) {
        setError(result.error ?? "Synthetic probe failed.");
        return;
      }
      setProbe(result.data);
      setNotice("Synthetic provider probe completed. No tenant data was sent.");
    } finally {
      setBusy(null);
    }
  }

  async function clearStop() {
    setError("");
    setNotice("");
    if (reason.trim().length < 10) {
      setError("Enter a reason of at least 10 characters.");
      return;
    }
    const confirmed = await confirm(
      "Clear the emergency stop? External AI stays disabled until a separate deliberate mode change.",
      { title: "Clear emergency stop?", confirmLabel: "Clear stop" }
    );
    if (!confirmed) return;
    setBusy("clear-stop");
    try {
      const result = await clearZeliProviderEmergencyStop(reason);
      if (!result.success) {
        setError(result.error ?? "The emergency stop could not be cleared.");
        return;
      }
      setNotice("Emergency stop cleared. External AI remains disabled.");
      router.refresh();
    } catch {
      setError("The emergency stop could not be cleared.");
    } finally {
      setBusy(null);
    }
  }

  async function authorizeTenant(enabled: boolean) {
    setError("");
    setNotice("");
    if (!authTenant || authReason.trim().length < 10) {
      setError("Choose a business and enter a reason of at least 10 characters.");
      return;
    }
    setBusy("auth");
    try {
      const result = await setTenantZeliAiAuthorization({
        tenantId: authTenant,
        enabled,
        reason: authReason,
      });
      if (!result.success) {
        setError(result.error ?? "Authorization failed.");
        return;
      }
      setNotice(enabled ? "Tenant authorization recorded." : "Tenant authorization removed.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card bg-white" aria-label="External AI control" data-testid="provider-control">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-slate-900">
            <ShieldCheck size={17} aria-hidden /> External AI control
          </h2>
          <p className="mt-1 text-sm text-slate-600">{state.message}</p>
        </div>
        <span
          className={`badge self-start ${
            state.policy.allowed ? "badge-green" : "badge-gray"
          }`}
        >
          {state.policy.state}
        </span>
      </div>

      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <Row label="Global mode" value={state.control.mode} />
        <Row label="Emergency stop" value={state.control.emergencyDisabled ? "ACTIVE" : "not active"} />
        <Row label="Provider" value="DeepSeek (optional)" />
        <Row label="Model" value={state.model} />
        <Row label="Server credential" value={state.policy.credentialConfigured ? "present" : "missing"} />
        <Row label="Code approval" value={state.policy.codeApprovalPresent ? "present" : "locked"} />
        <Row label="Privacy policy version" value={state.policy.privacyVersionPresent ? "matched" : "not matched"} />
        <Row label="Approval reference" value={state.policy.approvalReferencePresent ? "present" : "missing"} />
      </dl>

      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <strong>Production processing is locked.</strong> The approved aggregate-only
        mode requires a reviewed code change, a privacy policy version match, an
        approval reference and per-tenant authorization. No UI toggle can bypass
        those conditions.
      </div>

      <label className="mt-3 block text-sm">
        <span className="font-medium text-slate-700">Reason for this control change</span>
        <textarea
          className="mt-1 w-full"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy !== null}
          onClick={() => apply("synthetic", () => setZeliProviderMode({ mode: "synthetic", reason }))}
        >
          {busy === "synthetic" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Power size={13} aria-hidden />}
          Enable synthetic testing
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy !== null}
          onClick={() => apply("disable", () => setZeliProviderMode({ mode: "disabled", reason }))}
        >
          Disable external AI
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy !== null}
          onClick={() => apply("emergency", () => emergencyDisableZeliProvider(reason))}
        >
          <ShieldOff size={13} aria-hidden /> Emergency stop
        </button>
        {state.control.emergencyDisabled && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={clearStop}
            data-testid="clear-emergency-stop"
          >
            {busy === "clear-stop" ? (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            ) : (
              <ShieldCheck size={13} aria-hidden />
            )}
            Clear emergency stop
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy !== null || state.policy.state !== "synthetic"}
          onClick={probeProvider}
        >
          {busy === "probe" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <PlayCircle size={13} aria-hidden />}
          Run synthetic probe
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        Synthetic environment permission: {state.syntheticEnvAllowed ? "enabled" : "disabled"}.
        Synthetic probes send a fixed fake package only and are logged without payload values.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        The emergency stop latches: switching mode does not clear it. Clearing it requires a
        reason, is audited, and does not enable external AI or change the mode.
      </p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {notice}
        </p>
      )}
      {probe && (
        <p className="mt-3 text-xs text-slate-600">
          Probe: {probe.latencyMs} ms · input {probe.inputTokens ?? "?"} · output{" "}
          {probe.outputTokens ?? "?"} tokens
        </p>
      )}

      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
        <Metric label="Requests (24h)" value={state.usage24h.total} />
        <Metric label="Successful" value={state.usage24h.successes} />
        <Metric label="Denied" value={state.usage24h.denied} />
        <Metric label="Failed" value={state.usage24h.failures} />
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <h3 className="text-sm font-semibold text-slate-800">Tenant authorization (approved mode only)</h3>
        <p className="mt-1 text-xs text-slate-500">
          Even when granted, tenant authorization has no effect unless the global
          mode and all code/environment approvals are present.
        </p>
        {state.tenantAuthorizations.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {state.tenantAuthorizations.map((row) => (
              <li key={row.tenantId}>
                {row.tenantName} ({row.tenantCode}): {row.enabled ? "authorized" : "not authorized"}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <select
            className="min-w-0 flex-1"
            value={authTenant}
            onChange={(event) => setAuthTenant(event.target.value)}
            aria-label="Business for AI authorization"
          >
            <option value="">Choose a business</option>
            {state.tenants.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} ({row.code})
              </option>
            ))}
          </select>
          <input
            className="min-w-0 flex-1"
            placeholder="Reason (min 10 characters)"
            value={authReason}
            maxLength={500}
            onChange={(event) => setAuthReason(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => authorizeTenant(true)}
          >
            Authorize
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => authorizeTenant(false)}
          >
            Remove
          </button>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-amber-700">
          <AlertTriangle size={12} aria-hidden /> Authorizing a tenant never overrides the global
          switch or the code/environment approval gates.
        </p>
      </div>
      {confirmNode}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-bold text-slate-900">{value}</p>
    </div>
  );
}
