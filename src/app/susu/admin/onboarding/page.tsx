"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Search, UserPlus, Wallet } from "lucide-react";
import Notice from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import {
  addAccountToCustomerOnboarding,
  findCustomerCandidates,
  getOnboardingOptions,
  registerCustomerOnboarding,
} from "@/lib/actions/susu-onboarding.actions";

interface BranchOption {
  id: string;
  name: string;
  code: string;
}

interface CollectorOption {
  id: string;
  fullName: string;
  email: string;
  branchId: string | null;
}

interface CandidateAccount {
  id: string;
  accountId: string;
  status: string;
  dailyContribution: number;
  branchId: string | null;
}

interface Candidate {
  id: string;
  customerId: string;
  fullName: string;
  phone: string | null;
  accountCount: number;
  accounts: CandidateAccount[];
}

interface Options {
  branches: BranchOption[];
  collectors: CollectorOption[];
  branchless: boolean;
  defaultBranchId: string | null;
  limits: {
    nameMax: number;
    dailyContributionMax: number;
    cardFeeMax: number;
  };
}

const EMPTY_OPTIONS: Options = {
  branches: [],
  collectors: [],
  branchless: false,
  defaultBranchId: null,
  limits: { nameMax: 120, dailyContributionMax: 100000, cardFeeMax: 10000 },
};

export default function CustomerOnboardingPage() {
  const toast = useToast();

  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [existing, setExisting] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    customerName: string;
    customerId: string;
    accountId: string;
    branchName: string | null;
    portalEnabled: boolean;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await getOnboardingOptions();
      if (response.success) setOptions(response.data as Options);
    })();
  }, []);

  const search = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setCandidates(null);
      return;
    }
    setBusy("search");
    try {
      const response = await findCustomerCandidates(trimmed);
      if (response.success) {
        setCandidates((response.data as { customers: Candidate[] }).customers);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const branchNameOf = useCallback(
    (branchId: string | null) =>
      branchId ? options.branches.find((branch) => branch.id === branchId)?.name ?? null : null,
    [options.branches]
  );

  const collectors = useMemo(() => {
    const branchId = options.defaultBranchId;
    if (!branchId) return options.collectors;
    return options.collectors.filter(
      (collector) => !collector.branchId || collector.branchId === branchId
    );
  }, [options]);

  async function handleCreate(formData: FormData) {
    setBusy("create");
    setError("");
    try {
      const response = existing
        ? await addAccountToCustomerOnboarding(formData)
        : await registerCustomerOnboarding(formData);
      if (!response.success) {
        setError(response.error ?? "The customer could not be registered.");
        return;
      }
      const data = response.data as {
        customer: { customerId: string; fullName: string };
        susuAccount: { accountId: string; branchId: string | null };
        portalEnabled: boolean;
      };
      const branchName =
        options.branches.find((branch) => branch.id === data.susuAccount.branchId)?.name ??
        null;
      setCreated({
        customerName: data.customer.fullName,
        customerId: data.customer.customerId,
        accountId: data.susuAccount.accountId,
        branchName,
        portalEnabled: Boolean(data.portalEnabled),
      });
      toast.push(
        "success",
        existing ? "The new account was opened." : "The customer was registered."
      );
      setCandidates(null);
      setQuery("");
    } finally {
      setBusy(null);
    }
  }

  const limits = options.limits;

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-brand-900">Register a customer</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            One person, one customer record. A second savings account belongs to the same
            person — search for them first so the business does not end up with the same
            woman registered three times.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/susu/admin/customers" className="btn btn-secondary btn-sm">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Customers
          </Link>
          <Link href="/susu/admin/imports" className="btn btn-secondary btn-sm">
            Import a register
          </Link>
        </div>
      </header>

      {error ? <Notice type="error">{error}</Notice> : null}

      {created ? (
        <div className="space-y-2 rounded-control border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="text-lg font-semibold text-emerald-900">
            {created.customerName} is registered
          </h2>
          <dl className="grid gap-2 text-sm text-emerald-900 md:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide">Customer number</dt>
              <dd className="font-mono">{created.customerId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide">Savings account</dt>
              <dd className="font-mono">{created.accountId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide">Branch</dt>
              <dd>{created.branchName ?? "Unassigned"}</dd>
            </div>
          </dl>
          <p className="text-sm text-emerald-900">
            {created.portalEnabled
              ? "The customer portal is enabled. Give the person their temporary password."
              : "No portal password was set, so the customer cannot sign in yet."}{" "}
            The first savings cycle starts this month; no contribution has been recorded.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setCreated(null)}
            >
              <UserPlus className="mr-1 h-4 w-4" aria-hidden /> Register another
            </button>
            <Link href="/susu/admin/customers" className="btn btn-secondary btn-sm">
              Open the customer list
            </Link>
          </div>
        </div>
      ) : null}

      {!created ? (
        <>
          <div className="space-y-3 rounded-control border border-line bg-white p-5">
            <h2 className="text-lg font-semibold">1. Is this person already with us?</h2>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void search(query);
              }}
            >
              <label className="min-w-64 flex-1 text-sm">
                Phone, name, customer number or your reference
                <input
                  className="form-input mt-1 w-full"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="0244 123 456"
                />
              </label>
              <button type="submit" className="btn btn-secondary btn-sm" disabled={busy === "search"}>
                {busy === "search" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Search className="mr-1 h-4 w-4" aria-hidden />
                )}
                Search
              </button>
            </form>

            {candidates && candidates.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No one matches. Continue below to register a new customer.
              </p>
            ) : null}

            {candidates && candidates.length > 0 ? (
              <ul className="divide-y divide-line">
                {candidates.map((candidate) => (
                  <li key={candidate.id} className="flex flex-wrap items-center gap-3 py-2">
                    <div className="flex-1">
                      <p className="font-medium">{candidate.fullName}</p>
                      <p className="text-xs text-ink-muted">
                        {candidate.customerId}
                        {candidate.phone ? ` · ${candidate.phone}` : ""} ·{" "}
                        {candidate.accountCount} account(s)
                        {candidate.accounts
                          .map((account) => branchNameOf(account.branchId))
                          .filter((name): name is string => Boolean(name))
                          .join(", ")}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => {
                        setExisting(candidate);
                        setError("");
                      }}
                    >
                      <Wallet className="mr-1 h-4 w-4" aria-hidden /> Open another account
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {existing ? (
              <p className="rounded-control bg-brand-50 p-3 text-sm">
                Adding an account for <strong>{existing.fullName}</strong>.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setExisting(null)}
                >
                  Register someone new instead
                </button>
              </p>
            ) : null}
          </div>

          <form
            key={existing?.id ?? "new"}
            className="space-y-4 rounded-control border border-line bg-white p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate(new FormData(event.currentTarget));
            }}
          >
            <h2 className="text-lg font-semibold">
              {existing ? `2. The new account for ${existing.fullName}` : "2. Details"}
            </h2>

            {existing ? <input type="hidden" name="customerId" value={existing.id} /> : null}

            {!existing ? (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block text-sm">
                  Full name <span className="text-red-600">*</span>
                  <input name="fullName" required maxLength={limits.nameMax} className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm">
                  Phone number
                  <input name="phone" inputMode="tel" className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm">
                  E-mail
                  <input name="email" type="email" className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm">
                  Your reference
                  <input name="externalReference" maxLength={64} className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm md:col-span-2">
                  Address
                  <input name="address" className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm md:col-span-2">
                  Notes
                  <textarea name="notes" rows={2} className="form-input mt-1 w-full" />
                </label>
                <label className="block text-sm">
                  Temporary portal password (optional)
                  <input
                    name="temporaryPassword"
                    type="password"
                    autoComplete="new-password"
                    className="form-input mt-1 w-full"
                  />
                  <span className="mt-1 block text-xs text-ink-muted">
                    Leave blank if the customer should not sign in yet.
                  </span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-sm">
                Daily contribution <span className="text-red-600">*</span>
                <input
                  name="dailyContribution"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={limits.dailyContributionMax}
                  required
                  className="form-input mt-1 w-full"
                />
              </label>
              <label className="block text-sm">
                Card fee charged now
                <input
                  name="cardFee"
                  type="number"
                  step="0.01"
                  min="0"
                  max={limits.cardFeeMax}
                  defaultValue="0"
                  className="form-input mt-1 w-full"
                />
                <span className="mt-1 block text-xs text-ink-muted">
                  Records a real card sale. Leave at 0 if no card was sold.
                </span>
              </label>
              <label className="block text-sm">
                Account number in your book (optional)
                <input name="accountNumber" maxLength={32} className="form-input mt-1 w-full" />
              </label>
              <label className="block text-sm">
                Opening date
                <input name="openingDate" type="date" className="form-input mt-1 w-full" />
                <span className="mt-1 block text-xs text-ink-muted">
                  Keep the real date the savings started. Contributions are not back-filled.
                </span>
              </label>
              {!options.branchless ? (
                <label className="block text-sm">
                  Branch
                  <select
                    name="branchId"
                    className="form-input mt-1 w-full"
                    defaultValue={options.defaultBranchId ?? ""}
                    required
                  >
                    <option value="">Choose a branch</option>
                    {options.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="block text-sm">
                Collector (optional)
                <select name="collectorId" className="form-input mt-1 w-full" defaultValue="">
                  <option value="">No daily collector</option>
                  {collectors.map((collector) => (
                    <option key={collector.id} value={collector.id}>
                      {collector.fullName}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy === "create"}>
                {busy === "create" ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                ) : existing ? (
                  <Wallet className="mr-1 h-4 w-4" aria-hidden />
                ) : (
                  <UserPlus className="mr-1 h-4 w-4" aria-hidden />
                )}
                {existing ? "Open the account" : "Register the customer"}
              </button>
              {existing ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setExisting(null)}
                >
                  Cancel
                </button>
              ) : null}
            </div>
            <p className="text-xs text-ink-muted">
              Registering a customer creates the person, one savings account and its first
              monthly cycle. It never records a contribution, because no money has been
              collected at this point.
            </p>
          </form>
        </>
      ) : null}
    </section>
  );
}
