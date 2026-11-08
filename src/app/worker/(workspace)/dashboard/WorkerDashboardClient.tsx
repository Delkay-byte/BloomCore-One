"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowRight,
  CalendarCheck2,
  CheckCircle2,
  ClipboardList,
  MapPin,
  PlayCircle,
} from "lucide-react";
import CediAmount from "@/components/CediAmount";
import { useRedirectHandler } from "@/hooks/useRedirectHandler";
import { createDailyAccount } from "@/lib/actions/daily-account.actions";
import { resolveStoredDifference } from "@/lib/momo-reconciliation";
import { formatDate, getDailyQuote, getGreeting, getTodayString } from "@/lib/utils";

export interface DailyAccountView {
  id: string;
  businessDate: string;
  status: string;
  calculatedDifference: number;
  differenceStatus: string;
  calculatedMomoVariance: number;
  calculatedCashVariance: number;
  location: { name: string };
}

interface Props {
  userName: string;
  locationId: string | null;
  locationName: string | null;
  accounts: DailyAccountView[];
}

function statusBadge(status: string) {
  if (status === "draft") return { className: "badge badge-yellow", label: "Draft saved" };
  if (status === "submitted") return { className: "badge badge-green", label: "Submitted" };
  if (status === "reviewed") return { className: "badge badge-blue", label: "Reviewed" };
  return { className: "badge", label: status };
}

export default function WorkerDashboardClient({
  userName,
  locationId,
  locationName,
  accounts,
}: Props) {
  const handleRedirect = useRedirectHandler();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [quote] = useState(() => getDailyQuote("momo"));

  const todayAccount = accounts.find(
    (account) => account.businessDate.slice(0, 10) === getTodayString()
  );

  async function handleCreateAccount() {
    if (!locationId) return;
    setCreating(true);
    setError("");
    try {
      const result = await createDailyAccount(locationId, getTodayString());
      if (result.success) {
        const account = result.data as { id: string };
        router.push(`/worker/daily/${account.id}`);
      } else {
        setError(result.error || "Failed to open today's account");
      }
    } catch (err) {
      if (handleRedirect(err, setError, "An unexpected error occurred")) return;
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {getGreeting()}, {userName || "Agent"}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
          <MapPin size={14} aria-hidden />
          {locationName ? (
            <span>
              Location: <span className="font-medium text-slate-700">{locationName}</span>
            </span>
          ) : (
            <span>No location assigned to your account yet</span>
          )}
        </p>
        <p className="mt-2 text-sm italic text-emerald-700">&ldquo;{quote}&rdquo;</p>
      </section>

      {error && (
        <div role="alert" className="banner banner-error text-sm">
          {error}
        </div>
      )}

      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Today&apos;s account</h2>
            <p className="mt-1 text-sm text-slate-500">
              Open your account in the morning. Record deposits, cash out, airtime sales and
              additional funding, then count cash and confirm your MoMo float before submitting.
            </p>
          </div>
          <span className="hidden rounded-full bg-brand-50 p-2 text-brand-700 sm:block">
            <CalendarCheck2 size={18} aria-hidden />
          </span>
        </div>

        {todayAccount ? (
          <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={statusBadge(todayAccount.status).className}>
                  {statusBadge(todayAccount.status).label}
                </span>
                <span className="text-sm text-slate-500">{formatDate(todayAccount.businessDate)}</span>
              </div>
              {todayAccount.status === "draft" && (
                <Link href={`/worker/daily/${todayAccount.id}`} className="btn btn-primary btn-sm">
                  Continue account <ArrowRight size={14} aria-hidden />
                </Link>
              )}
            </div>
            {todayAccount.status !== "draft" ? (
              <div className="mt-3 flex items-center gap-2 text-sm text-emerald-800">
                <CheckCircle2 size={16} aria-hidden />
                Today&apos;s account has been submitted. Your administrator can now review it.
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 text-sm text-amber-800">
                <ClipboardList size={16} aria-hidden />
                Draft saved. Finish entering balances and submit when your cash and float are counted.
              </div>
            )}
          </div>
        ) : !locationId ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">No location assigned</p>
            <p className="mt-1">
              Your account needs a MoMo location before you can open a daily account. Ask your
              administrator to assign one.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center">
            <PlayCircle size={26} className="text-brand-600" aria-hidden />
            <div>
              <p className="font-medium text-slate-800">No account opened for today</p>
              <p className="text-sm text-slate-500">
                Start now and your progress saves as a draft automatically.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCreateAccount}
              className="btn btn-primary"
              disabled={creating}
              aria-busy={creating}
            >
              {creating ? (
                <>
                  <span className="spinner" aria-hidden /> Opening…
                </>
              ) : (
                "Start daily account"
              )}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Recent reports</h2>
        {accounts.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center">
            <ClipboardList size={24} className="text-slate-400" aria-hidden />
            <p className="text-sm text-slate-500">
              No reports yet. Your first submitted account will appear here.
            </p>
          </div>
        ) : (
          <ul className="mt-4 space-y-2">
            {accounts.slice(0, 10).map((account) => {
              const stored = resolveStoredDifference(account);
              const shortage = stored.status === "shortage";
              return (
                <li key={account.id}>
                  <Link
                    href={`/worker/daily/${account.id}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50/40"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {formatDate(account.businessDate)}
                      </p>
                      <p className="truncate text-xs text-slate-500">{account.location.name}</p>
                    </div>
                    <div className="text-right">
                      <span className={statusBadge(account.status).className}>
                        {statusBadge(account.status).label}
                      </span>
                      {account.status !== "draft" && (
                        <div className="mt-1 text-xs">
                          {stored.difference === 0 ? (
                            <span className="text-emerald-700">Balanced</span>
                          ) : shortage ? (
                            <span className="text-red-600">
                              Short <CediAmount amount={Math.abs(stored.difference)} /> · explanation
                              required
                            </span>
                          ) : (
                            <span className="text-emerald-700">
                              Positive <CediAmount amount={stored.difference} showSign />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
