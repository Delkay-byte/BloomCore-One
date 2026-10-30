import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform-auth";
import { getPlatformOverview } from "@/lib/actions/platform.actions";
import { formatDateTime } from "@/lib/utils";
import { tenantStatusBadge } from "../../tenant-ui";

export const dynamic = "force-dynamic";

export default async function PlatformDashboardPage() {
  await requirePlatformPage();
  const data = await getPlatformOverview();

  const moduleTotal = Math.max(1, data.modules.momoOnly + data.modules.susuOnly + data.modules.both);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Platform Overview</h1>
        <p className="text-sm text-gray-500 mt-1">
          Operational oversight of every enrolled business.
        </p>
      </div>

      {/* Enrollment call-to-action */}
      <div className="card bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-900">Enroll a new business</h2>
          <p className="text-sm text-gray-500">
            Register a MoMo business, a Susu agency, or a business operating both modules.
          </p>
        </div>
        <Link href="/platform/tenants/new" className="btn btn-primary whitespace-nowrap">
          ➕ Enroll Business
        </Link>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Enrolled businesses" value={data.totals.total} tone="slate" />
        <StatCard label="Active" value={data.totals.active} tone="green" />
        <StatCard label="Suspended" value={data.totals.suspended} tone="red" />
        <StatCard label="Onboarding" value={data.onboarding.inProgress + data.onboarding.notStarted} tone="amber" />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Module distribution */}
        <div className="card bg-white">
          <h2 className="font-semibold text-gray-900 mb-4">Business distribution by module</h2>
          <div className="space-y-3">
            <DistributionRow label="MoMo only" value={data.modules.momoOnly} total={moduleTotal} color="bg-emerald-500" />
            <DistributionRow label="Susu only" value={data.modules.susuOnly} total={moduleTotal} color="bg-sky-500" />
            <DistributionRow label="MoMo + Susu" value={data.modules.both} total={moduleTotal} color="bg-violet-500" />
          </div>
          <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2 text-sm text-gray-600">
            <p>MoMo-enabled: <span className="font-semibold">{data.modules.momoEnabled}</span></p>
            <p>Susu-enabled: <span className="font-semibold">{data.modules.susuEnabled}</span></p>
          </div>
        </div>

        {/* Platform health */}
        <div className="card bg-white">
          <h2 className="font-semibold text-gray-900 mb-4">Platform health</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Database</dt>
              <dd>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                    data.health.database === "connected"
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      data.health.database === "connected" ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                  {data.health.database === "connected" ? "Connected" : "Unavailable"}
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Environment</dt>
              <dd className="text-gray-900">{data.health.appEnv || data.health.nodeEnv || "unknown"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Deployed build</dt>
              <dd className="text-gray-900 font-mono text-xs">
                {data.health.commit ? data.health.commit.slice(0, 12) : "not reported"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-gray-500">Checked at</dt>
              <dd className="text-gray-900">{formatDateTime(new Date(data.health.checkedAt))}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Recent enrollments */}
        <div className="card bg-white">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Recently enrolled</h2>
            <Link href="/platform/tenants" className="text-xs text-slate-600 hover:text-slate-800">
              View all →
            </Link>
          </div>
          {data.recentTenants.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">
              No businesses enrolled yet. Use <Link href="/platform/tenants/new" className="text-slate-700 underline">Enroll Business</Link> to add the first one.
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentTenants.map((t) => (
                <li key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/platform/tenants/${t.id}`} className="text-sm font-medium text-gray-900 hover:text-slate-700 truncate block">
                      {t.name}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {t.code} · {moduleLabel(t.momoEnabled, t.susuEnabled)} · {formatDateTime(t.createdAt)}
                    </p>
                  </div>
                  {tenantStatusBadge(t.status)}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent platform activity */}
        <div className="card bg-white">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-900">Recent platform activity</h2>
            <Link href="/platform/audit" className="text-xs text-slate-600 hover:text-slate-800">
              Full history →
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No platform activity recorded yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.recentActivity.map((e) => (
                <li key={e.id} className="py-2.5">
                  <p className="text-sm text-gray-900">{describeAction(e.action)}</p>
                  <p className="text-xs text-gray-500">
                    {e.actorEmail || "system"} · {e.tenantCode ? `${e.tenantCode} · ` : ""}
                    {formatDateTime(e.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function moduleLabel(momo: boolean, susu: boolean) {
  if (momo && susu) return "MoMo + Susu";
  if (momo) return "MoMo only";
  if (susu) return "Susu only";
  return "No modules";
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = {
    slate: "bg-white text-gray-900",
    green: "bg-white text-gray-900",
    red: "bg-white text-gray-900",
    amber: "bg-white text-gray-900",
  };
  return (
    <div className={`card ${tones[tone] ?? tones.slate}`}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}

function DistributionRow({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = Math.round((value / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1">
        <span className="text-gray-700">{label}</span>
        <span className="text-gray-900 font-medium">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function describeAction(action: string): string {
  const map: Record<string, string> = {
    "platform.login": "Platform operator signed in",
    "platform.login_failed": "Failed platform sign-in attempt",
    "platform.logout": "Platform operator signed out",
    "platform.password_changed": "Platform password changed",
    "tenant.created": "Business enrolled",
    "tenant.activated": "Business activated",
    "tenant.suspended": "Business suspended",
    "tenant.reactivated": "Business reactivated",
    "tenant.profile_updated": "Business profile updated",
    "tenant.modules_changed": "Module configuration changed",
    "tenant.admin_provisioned": "Tenant administrator provisioned",
    "tenant.admin_recovery_initiated": "Tenant administrator access reset",
    "tenant.onboarding_updated": "Onboarding status updated",
  };
  return map[action] ?? action;
}
