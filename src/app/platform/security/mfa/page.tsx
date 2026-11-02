import { requirePlatformPage } from "@/lib/platform-auth";
import MfaSettings from "@/components/security/MfaSettings";

export const metadata = { title: "Platform security" };

export default async function PlatformMfaSettingsPage() {
  await requirePlatformPage();
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Platform security</h1>
        <p className="text-sm text-slate-500 mt-1">
          Two-factor authentication for platform operators.
        </p>
      </div>
      <div className="card">
        <MfaSettings />
      </div>
    </div>
  );
}
