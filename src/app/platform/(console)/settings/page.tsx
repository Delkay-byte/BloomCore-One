import { requirePlatformAdmin } from "@/lib/platform-auth";
import { getPlatformAuditLogs } from "@/lib/platform-audit";
import PlatformPasswordForm from "./PlatformPasswordForm";

export const dynamic = "force-dynamic";

export default async function PlatformSettingsPage() {
  const session = await requirePlatformAdmin();
  const lastLogins = await getPlatformAuditLogs({ page: 1, limit: 5, action: "platform.login" });

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Operator account and platform security.</p>
      </div>

      <div className="card bg-white">
        <h2 className="font-semibold text-gray-900 mb-4">Operator account</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">Name</dt>
            <dd className="text-gray-900">{session.fullName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Email</dt>
            <dd className="text-gray-900">{session.email}</dd>
          </div>
          {session.forcePasswordReset && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm mt-2">
              A password change is required before using the platform console.
            </div>
          )}
        </dl>
      </div>

      <div className="card bg-white">
        <h2 className="font-semibold text-gray-900 mb-1">Change password</h2>
        <p className="text-xs text-gray-500 mb-4">
          Changing your password signs out all other platform sessions.
        </p>
        <PlatformPasswordForm />
      </div>

      <div className="card bg-white">
        <h2 className="font-semibold text-gray-900 mb-4">Recent platform sign-ins</h2>
        {lastLogins.logs.length === 0 ? (
          <p className="text-sm text-gray-500">No sign-ins recorded yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {lastLogins.logs.map((e) => (
              <li key={e.id} className="py-2 flex justify-between">
                <span className="text-gray-700">{e.actorEmail}</span>
                <span className="text-gray-500 text-xs">{new Date(e.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
