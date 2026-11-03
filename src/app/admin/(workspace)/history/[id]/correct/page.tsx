import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenantAdminMomo } from "@/lib/tenant";
import { getDailyAccountCorrectionData } from "@/lib/actions/daily-account.actions";
import { formatDateTime } from "@/lib/utils";
import CorrectionForm from "./CorrectionForm";

export const dynamic = "force-dynamic";

/**
 * Dedicated administrative correction screen for a submitted or reviewed
 * daily account.
 *
 * Authorization is enforced twice: the page resolves a tenant-admin + MoMo
 * context before rendering, and `correctDailyAccount` re-checks the same
 * context on submit. The page never trusts an id from an unauthenticated
 * visitor and never exposes another tenant's record.
 */
export default async function DailyAccountCorrectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireTenantAdminMomo();
  const { id } = await params;
  const data = await getDailyAccountCorrectionData(id);
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/history"
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          ← Money &amp; History
        </Link>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              Correct daily account
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {data.location.name} · {formatDateTime(data.businessDate)} ·{" "}
              {data.worker.fullName}
            </p>
          </div>
          <span
            className={`badge self-start ${
              data.status === "reviewed" ? "badge-green" : "badge-blue"
            }`}
          >
            {data.status}
          </span>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        A correction preserves the current figures as an immutable revision
        before updating the live record. It does not create a new transaction or
        adjust a balance. Every correction is audited with the reason, author and
        time.
      </div>

      <CorrectionForm data={data} />
    </div>
  );
}
