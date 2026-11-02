import Link from "next/link";
import { BrandLockup } from "@/components/brand/Brand";

/**
 * Password recovery entry point.
 *
 * No transactional email provider is configured, so the application must not
 * claim that an email was sent. Recovery is administrator-assisted: the code is
 * issued face-to-face or through an independently verified channel.
 */
export const metadata = { title: "Password recovery" };

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 to-green-100 px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <BrandLockup size={56} className="justify-center" />
        </div>

        <div className="card">
          <h1 className="text-xl font-semibold mb-2">Password recovery</h1>
          <p className="text-sm text-slate-600">
            BloomCore One uses administrator-assisted recovery. For your
            security, recovery codes are never sent by email.
          </p>

          <div className="mt-5 space-y-4 text-sm">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="font-semibold text-slate-900">Workers, agents, collectors and customers</p>
              <p className="text-slate-600 mt-1">
                Contact your business administrator. They will verify your
                identity and issue a one-time recovery code.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="font-semibold text-slate-900">Business owners and tenant administrators</p>
              <p className="text-slate-600 mt-1">
                Contact the BloomCore platform administrator. They will verify
                your identity and issue a one-time recovery code.
              </p>
            </div>
          </div>

          <Link href="/recover-account" className="btn btn-primary w-full mt-6 text-center">
            I have a recovery code
          </Link>

          <p className="text-xs text-slate-500 mt-4">
            Recovery codes expire after 30 minutes and work once. You will choose
            a new password and, if your account uses two-factor authentication,
            complete verification before regaining access.
          </p>
        </div>

        <p className="text-center mt-6">
          <Link href="/login" className="text-sm text-brand-700 hover:text-brand-800">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
