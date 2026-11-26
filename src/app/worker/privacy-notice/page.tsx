import Link from "next/link";
import { redirect } from "next/navigation";
import { getMomoSession, getSusuSession } from "@/lib/auth";
import { getMyOnboardingNotice } from "@/lib/actions/onboarding-notice.actions";
import WorkerRightsRequest from "@/components/WorkerRightsRequest";

export const dynamic = "force-dynamic";

/** Agent-accessible copy of the notice and its acknowledgement record. */
export default async function WorkerPrivacyNoticePage() {
  const session = (await getMomoSession()) ?? (await getSusuSession());
  if (!session) redirect("/login?role=momo");
  const result = await getMyOnboardingNotice();
  if (!result.success || !result.data) {
    return (
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <h1 className="text-base font-bold text-slate-900">Employee privacy notice</h1>
        <p className="mt-2 text-sm text-slate-600">
          {result.error ?? "No notice is available."}
        </p>
        <Link className="btn btn-secondary btn-sm mt-4" href="/worker/dashboard">
          Return to dashboard
        </Link>
      </section>
    );
  }
  const notice = result.data;
  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      <h1 className="text-base font-bold text-slate-900">{notice.title}</h1>
      {notice.provisional && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Provisional statutory notice. Your employer has not yet published its controlled
          notice, so this text does not satisfy the contribution gate.
        </p>
      )}
      <p className="mt-1 text-xs text-slate-600">
        Version {notice.version} · SHA-256 {notice.documentHash} · policy {notice.policyVersion}
      </p>
      <p className="mt-2 text-xs text-slate-600">
        {notice.acknowledged
          ? `Acknowledged ${new Date(notice.acknowledgedAt!).toLocaleString()}.`
          : "Not yet acknowledged. Complete acknowledgement at first login."}
      </p>
      <pre className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-xs text-slate-700">
        {notice.documentText}
      </pre>
      <p className="mt-3 text-xs text-slate-600">{notice.statement}</p>
      <WorkerRightsRequest />
      <Link className="btn btn-secondary btn-sm mt-4" href="/worker/dashboard">
        Return to dashboard
      </Link>
    </section>
  );
}
