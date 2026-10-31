import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileClock,
  Layers,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { requirePlatformPage } from "@/lib/platform-auth";
import { getPlatformOverview } from "@/lib/actions/platform.actions";
import { formatDateTime } from "@/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/DataDisplay";
import { tenantStatusBadge } from "../../tenant-ui";

export const dynamic = "force-dynamic";

export default async function PlatformDashboardPage() {
  await requirePlatformPage();
  const data = await getPlatformOverview();

  const moduleTotal = Math.max(1, data.modules.momoOnly + data.modules.susuOnly + data.modules.both);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform Overview"
        description="Operational oversight of every enrolled business."
        actions={
          <Link href="/platform/tenants/new" className="btn btn-primary">
            <UserPlus size={16} aria-hidden /> Enroll Business
          </Link>
        }
      />

      {/* Primary numbers — one hero figure, supporting figures compact */}
      <div className="card bg-white flex flex-col sm:flex-row sm:items-center gap-6">
        <div className="sm:border-r sm:border-slate-200 sm:pr-8">
          <p className="section-title">Enrolled businesses</p>
          <p className="text-4xl font-bold text-brand-800 tnum mt-1">{data.totals.total}</p>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-6 flex-1">
          <div>
            <dt className="section-title">Active</dt>
            <dd className="text-xl font-bold text-emerald-700 tnum mt-0.5">{data.totals.active}</dd>
          </div>
          <div>
            <dt className="section-title">Suspended</dt>
            <dd className="text-xl font-bold text-red-700 tnum mt-0.5">{data.totals.suspended}</dd>
          </div>
          <div>
            <dt className="section-title">Provisioning</dt>
            <dd className="text-xl font-bold text-amber-700 tnum mt-0.5">{data.totals.provisioning}</dd>
          </div>
          <div>
            <dt className="section-title">Needs setup</dt>
            <dd className="text-xl font-bold text-slate-900 tnum mt-0.5">
              {data.onboarding.notStarted + data.onboarding.inProgress}
            </dd>
          </div>
        </dl>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Module distribution */}
        <div className="card bg-white lg:col-span-3">
          <div className="flex items-center gap-2 mb-4">
            <Layers size={16} className="text-brand-500" aria-hidden />
            <h2 className="font-semibold text-slate-900">Business distribution by module</h2>
          </div>
          <div className="space-y-4">
            <DistributionRow
              label="MoMo only"
              value={data.modules.momoOnly}
              total={moduleTotal}
              barClass="bg-brand-500"
            />
            <DistributionRow
              label="Susu only"
              value={data.modules.susuOnly}
              total={moduleTotal}
              barClass="bg-gold-500"
            />
            <DistributionRow
              label="MoMo + Susu"
              value={data.modules.both}
              total={moduleTotal}
              barClass="bg-brand-800"
            />
          </div>
          <div className="mt-5 pt-4 border-t border-slate-100 grid grid-cols-2 gap-2 text-sm text-slate-600">
            <p>MoMo-enabled: <span className="font-semibold tnum">{data.modules.momoEnabled}</span></p>
            <p>Susu-enabled: <span className="font-semibold tnum">{data.modules.susuEnabled}</span></p>
          </div>
        </div>

        {/* Platform health */}
        <div className="card bg-white lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck size={16} className="text-brand-500" aria-hidden />
            <h2 className="font-semibold text-slate-900">Platform health</h2>
          </div>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Database</dt>
              <dd>
                <span
                  className={`badge ${
                    data.health.database === "connected" ? "badge-green" : "badge-red"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      data.health.database === "connected" ? "bg-emerald-600" : "bg-red-600"
                    }`}
                    aria-hidden
                  />
                  {data.health.database === "connected" ? "Connected" : "Unavailable"}
                </span>
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Environment</dt>
              <dd className="text-slate-900">{data.health.appEnv || data.health.nodeEnv || "unknown"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Deployed build</dt>
              <dd className="text-slate-900 font-mono text-xs">
                {data.health.commit ? data.health.commit.slice(0, 12) : "not reported"}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Checked at</dt>
              <dd className="text-slate-900">{formatDateTime(new Date(data.health.checkedAt))}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Recent enrollments */}
        <div className="card bg-white">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Building2 size={16} className="text-brand-500" aria-hidden />
              <h2 className="font-semibold text-slate-900">Recently enrolled</h2>
            </div>
            <Link href="/platform/tenants" className="text-xs font-medium text-brand-700 hover:text-brand-800 inline-flex items-center gap-1">
              View all <ArrowRight size={12} aria-hidden />
            </Link>
          </div>
          {data.recentTenants.length === 0 ? (
            <EmptyState
              icon={<Building2 />}
              title="No businesses enrolled yet"
              hint="Use Enroll Business to add the first one — it takes about a minute."
              action={
                <Link href="/platform/tenants/new" className="btn btn-primary btn-sm">
                  <UserPlus size={14} aria-hidden /> Enroll Business
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentTenants.map((t) => (
                <li key={t.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/platform/tenants/${t.id}`} className="text-sm font-medium text-slate-900 hover:text-brand-700 truncate block">
                      {t.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      <span className="font-mono">{t.code}</span> · {moduleLabel(t.momoEnabled, t.susuEnabled)} · {formatDateTime(t.createdAt)}
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
            <div className="flex items-center gap-2">
              <FileClock size={16} className="text-brand-500" aria-hidden />
              <h2 className="font-semibold text-slate-900">Recent platform activity</h2>
            </div>
            <Link href="/platform/audit" className="text-xs font-medium text-brand-700 hover:text-brand-800 inline-flex items-center gap-1">
              Full history <ArrowRight size={12} aria-hidden />
            </Link>
          </div>
          {data.recentActivity.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 />}
              title="No platform activity recorded yet"
              hint="Privileged actions — enrollments, suspensions, recovery — appear here."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentActivity.map((e) => (
                <li key={e.id} className="py-2.5">
                  <p className="text-sm text-slate-900">{describeAction(e.action)}</p>
                  <p className="text-xs text-slate-500">
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

function DistributionRow({
  label,
  value,
  total,
  barClass,
}: {
  label: string;
  value: number;
  total: number;
  barClass: string;
}) {
  const pct = Math.round((value / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1.5">
        <span className="text-slate-700 font-medium">{label}</span>
        <span className="text-slate-900 font-semibold tnum">{value}</span>
      </div>
      <div
        className="h-2 rounded-full bg-slate-100 overflow-hidden"
        role="img"
        aria-label={`${label}: ${value} of ${total} businesses (${pct}%)`}
      >
        <div className={`h-full ${barClass}`} style={{ width: `${pct}%` }} />
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
