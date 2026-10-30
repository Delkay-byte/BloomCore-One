import { KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { getPlatformAuditLogs } from "@/lib/platform-audit";
import { PageHeader } from "@/components/ui/DataDisplay";
import PlatformPasswordForm from "./PlatformPasswordForm";

export const dynamic = "force-dynamic";

export default async function PlatformSettingsPage() {
  const session = await requirePlatformAdmin();
  const lastLogins = await getPlatformAuditLogs({ page: 1, limit: 5, action: "platform.login" });

  return (
    <div className="space-y-6 max-w-2xl">
      <PageHeader
        title="Platform Settings"
        description="Operator account and platform security."
      />

      <div className="card bg-white">
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck size={16} className="text-brand-500" aria-hidden />
          <h2 className="font-semibold text-slate-900">Operator account</h2>
        </div>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Name</dt>
            <dd className="text-slate-900">{session.fullName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Email</dt>
            <dd className="text-slate-900">{session.email}</dd>
          </div>
          {session.forcePasswordReset && (
            <div className="banner banner-warning mt-2">
              <span aria-hidden>⚠</span>
              <span>A password change is required before using the platform console.</span>
            </div>
          )}
        </dl>
      </div>

      <div className="card bg-white">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={16} className="text-brand-500" aria-hidden />
          <h2 className="font-semibold text-slate-900">Change password</h2>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Changing your password signs out all other platform sessions.
        </p>
        <PlatformPasswordForm />
      </div>

      <div className="card bg-white">
        <div className="flex items-center gap-2 mb-4">
          <LogIn size={16} className="text-brand-500" aria-hidden />
          <h2 className="font-semibold text-slate-900">Recent platform sign-ins</h2>
        </div>
        {lastLogins.logs.length === 0 ? (
          <p className="text-sm text-slate-500">No sign-ins recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {lastLogins.logs.map((e) => (
              <li key={e.id} className="py-2 flex justify-between gap-4">
                <span className="text-slate-700">{e.actorEmail}</span>
                <span className="text-slate-500 text-xs whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
