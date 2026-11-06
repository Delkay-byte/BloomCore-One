import Link from "next/link";

export default function ZeliUnavailable({
  reason,
  compact = false,
}: {
  reason?: string | null;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "" : "mx-auto max-w-2xl py-12"}>
      <div className="card bg-white text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-gold-600">
          MaaCash
        </p>
        <h1 className="mt-1 text-2xl font-bold text-brand-900">
          Zeli is temporarily unavailable
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          The platform administrator has paused all Zeli features. Your business
          records, reports, subscriptions and audit history are preserved.
        </p>
        {reason && <p className="mt-2 text-xs text-slate-500">{reason}</p>}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/admin/dashboard" className="btn btn-primary btn-sm">
            Open business dashboard
          </Link>
          <Link href="/zeli" className="btn btn-secondary btn-sm">
            Check Zeli again
          </Link>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Payment processing and subscription records continue normally.
        </p>
      </div>
    </div>
  );
}
