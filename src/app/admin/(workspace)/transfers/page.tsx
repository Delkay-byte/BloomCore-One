"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRightLeft, Banknote, RefreshCw, Vault } from "lucide-react";
import CediAmount from "@/components/CediAmount";
import Notice from "@/components/ui/Notice";
import {
  createBranchTransfer,
  declareBranchBalance,
  getBranchTransferBoard,
  getTransferLocationOptions,
  type BranchTransferBoardView,
} from "@/lib/actions/branch-transfer.actions";
import {
  BRANCH_ASSET_DEFINITIONS,
  BRANCH_ASSET_TYPES,
  type BranchAssetType,
  type BranchTransferStatus,
} from "@/lib/branch-transfers";
import TransferStatusBadge from "@/components/momo/TransferStatusBadge";

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SOURCE_LABEL: Record<string, string> = {
  manual_declaration: "Manual declaration",
  declaration_plus_transfers: "Declaration + transfers since",
  no_declared_balance: "No declared balance",
};

export default function AdminTransfersPage() {
  const [data, setData] = useState<BranchTransferBoardView | null>(null);
  const [locations, setLocations] = useState<
    Array<{ id: string; name: string; code: string }>
  >([]);
  const [declaredKeys, setDeclaredKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [declaration, setDeclaration] = useState({
    locationId: "",
    assetType: "cash" as BranchAssetType,
    declaredBalance: "",
    note: "",
  });
  const [transfer, setTransfer] = useState({
    sourceLocationId: "",
    destinationLocationId: "",
    assetType: "cash" as BranchAssetType,
    amount: "",
    purpose: "",
    idempotencyKey: newKey(),
  });

  const load = useCallback(async () => {
    setError("");
    try {
      const [board, options] = await Promise.all([
        getBranchTransferBoard(),
        getTransferLocationOptions(),
      ]);
      setData(board);
      setLocations(options.locations);
      setDeclaredKeys(options.declared);
      setDeclaration((current) => ({
        ...current,
        locationId: current.locationId || options.locations[0]?.id || "",
      }));
      setTransfer((current) => ({
        ...current,
        sourceLocationId: current.sourceLocationId || options.locations[0]?.id || "",
        destinationLocationId:
          current.destinationLocationId || options.locations[1]?.id || "",
      }));
    } catch {
      setError("The cash and float board could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const declaredSet = useMemo(() => new Set(declaredKeys), [declaredKeys]);

  async function handleDeclare() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await declareBranchBalance({
        locationId: declaration.locationId,
        assetType: declaration.assetType,
        declaredBalance: Number(declaration.declaredBalance),
        note: declaration.note.trim() || undefined,
      });
      if (!result.success) {
        setError(result.error ?? "The declaration could not be saved.");
        return;
      }
      setSuccess("Balance declared. It is an internal declaration, not a provider balance.");
      setDeclaration((current) => ({ ...current, declaredBalance: "", note: "" }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateTransfer() {
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await createBranchTransfer({
        sourceLocationId: transfer.sourceLocationId,
        destinationLocationId: transfer.destinationLocationId,
        assetType: transfer.assetType,
        amount: Number(transfer.amount),
        purpose: transfer.purpose.trim() || undefined,
        idempotencyKey: transfer.idempotencyKey,
      });
      if (!result.success) {
        setError(result.error ?? "The transfer could not be created.");
        return;
      }
      setSuccess(
        "Transfer requested. It needs approval by a different administrator before dispatch."
      );
      setTransfer((current) => ({
        ...current,
        amount: "",
        purpose: "",
        idempotencyKey: newKey(),
      }));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cash &amp; float control</h1>
          <p className="mt-1 text-sm text-slate-600">
            Internal declarations and branch transfers. These are not real-time
            telco or aggregator balances.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary">
          <RefreshCw size={15} aria-hidden /> Refresh
        </button>
      </div>

      {error && <Notice type="error" message={error} />}
      {success && <Notice type="success" message={success} />}

      {loading || !data ? (
        <p className="text-sm text-slate-500">Loading internal positions…</p>
      ) : (
        <>
          <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Total label="Declared physical cash" amount={data.board.declaredCashTotal} />
            <Total label="Effective physical cash" amount={data.board.effectiveCashTotal} />
            <Total label="Declared float" amount={data.board.declaredFloatTotal} />
            <Total label="Effective float" amount={data.board.effectiveFloatTotal} />
          </section>

          <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            “Effective” = the last manual declaration plus transfers whose dispatch
            or receipt happened after that declaration. A location with no
            declaration is excluded from totals ({data.board.missingDeclarations}{" "}
            missing declaration{data.board.missingDeclarations === 1 ? "" : "s"}),
            never treated as zero.
          </p>

          <section className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Count label="Awaiting approval" value={data.counts.awaitingApproval} />
            <Count label="Approved, not dispatched" value={data.counts.awaitingReceipt} />
            <Count label="In transit" value={data.counts.inTransit} />
            <Count label="Discrepancies" value={data.counts.discrepancies} />
            <Count label="Open transfers" value={data.counts.open} />
            <Count label="Completed" value={data.counts.completed} />
          </section>

          <section className="card p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Banknote size={15} aria-hidden /> Declare an internal balance
            </h2>
            <p className="mt-1 text-xs text-slate-600">
              A declaration is a snapshot. Transfers recorded after it adjust the
              effective position automatically; you do not need to re-declare
              after every transfer.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Field label="Location">
                <select
                  value={declaration.locationId}
                  onChange={(e) => setDeclaration({ ...declaration, locationId: e.target.value })}
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name} ({location.code})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Asset">
                <select
                  value={declaration.assetType}
                  onChange={(e) =>
                    setDeclaration({ ...declaration, assetType: e.target.value as BranchAssetType })
                  }
                >
                  {BRANCH_ASSET_TYPES.map((asset) => (
                    <option key={asset} value={asset}>
                      {BRANCH_ASSET_DEFINITIONS[asset].label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Declared balance (GH₵)">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={declaration.declaredBalance}
                  onChange={(e) =>
                    setDeclaration({ ...declaration, declaredBalance: e.target.value })
                  }
                  placeholder="0.00"
                />
              </Field>
              <Field label="Note (optional)">
                <input
                  type="text"
                  maxLength={300}
                  value={declaration.note}
                  onChange={(e) => setDeclaration({ ...declaration, note: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleDeclare}
                  disabled={busy || !declaration.locationId}
                  className="btn btn-primary w-full"
                >
                  Save declaration
                </button>
              </div>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <ArrowRightLeft size={15} aria-hidden /> Request a branch transfer
            </h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <Field label="From">
                <select
                  value={transfer.sourceLocationId}
                  onChange={(e) => setTransfer({ ...transfer, sourceLocationId: e.target.value })}
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="To">
                <select
                  value={transfer.destinationLocationId}
                  onChange={(e) =>
                    setTransfer({ ...transfer, destinationLocationId: e.target.value })
                  }
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Asset">
                <select
                  value={transfer.assetType}
                  onChange={(e) =>
                    setTransfer({ ...transfer, assetType: e.target.value as BranchAssetType })
                  }
                >
                  {BRANCH_ASSET_TYPES.map((asset) => (
                    <option key={asset} value={asset}>
                      {BRANCH_ASSET_DEFINITIONS[asset].shortLabel}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Amount (GH₵)">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={transfer.amount}
                  onChange={(e) => setTransfer({ ...transfer, amount: e.target.value })}
                  placeholder="0.00"
                />
              </Field>
              <Field label="Purpose (optional)">
                <input
                  type="text"
                  maxLength={200}
                  value={transfer.purpose}
                  onChange={(e) => setTransfer({ ...transfer, purpose: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleCreateTransfer}
                  disabled={busy || !transfer.amount}
                  className="btn btn-primary w-full"
                >
                  Request transfer
                </button>
              </div>
            </div>
            {!declaredSet.has(`${transfer.sourceLocationId}:${transfer.assetType}`) && (
              <p className="mt-2 text-xs text-amber-800">
                The sending location has no declared balance for this asset yet.
                Declare it first; the request will be refused otherwise.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-bold text-slate-900">Positions by location</h2>
            {data.board.locations.map((location) => (
              <div key={location.locationId} className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">
                    {location.locationName}{" "}
                    <span className="text-xs font-normal text-slate-500">
                      ({location.locationCode})
                    </span>
                  </p>
                  <p className="text-xs text-slate-500">
                    Cash <CediAmount amount={location.cashTotal ?? 0} /> · Float{" "}
                    <CediAmount amount={location.floatTotal ?? 0} />
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Declared</th>
                        <th>Transfer adjustment</th>
                        <th>Effective</th>
                        <th>Source of figure</th>
                        <th>Declared at</th>
                      </tr>
                    </thead>
                    <tbody>
                      {location.assets.map((asset) => (
                        <tr key={asset.assetType}>
                          <td className="text-xs font-medium">{asset.label}</td>
                          <td className="text-xs tnum">
                            {asset.declared === null ? "—" : <CediAmount amount={asset.declared} />}
                          </td>
                          <td className="text-xs tnum">
                            <CediAmount amount={asset.adjustment} showSign={asset.adjustment !== 0} />
                          </td>
                          <td className="text-xs font-semibold tnum">
                            {asset.effective === null ? "Not declared" : <CediAmount amount={asset.effective} />}
                          </td>
                          <td className="text-xs">{SOURCE_LABEL[asset.source]}</td>
                          <td className="text-xs text-slate-500">
                            {asset.declaredAt ? new Date(asset.declaredAt).toLocaleString("en-GB") : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          <section className="card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-bold text-slate-900">Transfers</h2>
              <p className="text-xs text-slate-500">{data.transfers.length} shown</p>
            </div>
            {data.transfers.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">No branch transfers yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Asset</th>
                      <th>From → To</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Requested by</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.transfers.map((row) => (
                      <tr key={row.id}>
                        <td className="text-xs font-semibold">
                          <Link href={`/admin/transfers/${row.id}`} className="text-brand-700 hover:underline">
                            {row.reference}
                          </Link>
                        </td>
                        <td className="text-xs">
                          {BRANCH_ASSET_DEFINITIONS[row.assetType as BranchAssetType]?.shortLabel ?? row.assetType}
                        </td>
                        <td className="text-xs">
                          {row.sourceLocationName} → {row.destinationLocationName}
                        </td>
                        <td className="tnum text-xs"><CediAmount amount={row.amount} /></td>
                        <td className="text-xs">
                          <TransferStatusBadge
                            status={row.status as BranchTransferStatus}
                            label={row.statusLabel}
                          />
                        </td>
                        <td className="text-xs">{row.initiatedByName ?? "—"}</td>
                        <td className="text-right">
                          <Link href={`/admin/transfers/${row.id}`} className="text-xs font-semibold text-brand-700 hover:underline">
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <AlertTriangle size={14} className="mt-0.5 flex-none" aria-hidden />
            Declared balances and transfers are internal records. No telco or
            aggregator integration is configured, and no figure here is a
            provider-confirmed real-time balance.
          </p>
        </>
      )}
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

function Total({ label, amount }: { label: string; amount: number | null }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold tnum text-slate-900">
        {amount === null ? "—" : <CediAmount amount={amount} />}
      </p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold tnum text-slate-900">{value}</p>
    </div>
  );
}
