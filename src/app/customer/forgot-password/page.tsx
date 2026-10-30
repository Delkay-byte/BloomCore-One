"use client";

import Link from "next/link";

export default function CustomerForgotPasswordPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img
            src="/branding/bik-prestige-logo.svg"
            alt="BIK Prestige Enterprise"
            className="h-16 w-auto mx-auto"
            width={256}
            height={128}
          />
          <h1 className="text-2xl font-bold text-slate-900 mt-4">Forgot Password?</h1>
        </div>
        <div className="card">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-blue-800 font-medium mb-2">Password Recovery</p>
            <p className="text-sm text-blue-700">
              During the pilot phase, password recovery is handled by your administrator.
            </p>
            <p className="text-sm text-blue-700 mt-2">
              Please contact your administrator to reset your password. They can generate
              a new temporary password for your account.
            </p>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-slate-600">
              <strong>What your administrator can do:</strong>
            </p>
            <ul className="text-sm text-slate-600 mt-2 space-y-1 list-disc list-inside">
              <li>Reset your portal password</li>
              <li>Provide a new temporary password</li>
              <li>Force a password change on your next login</li>
            </ul>
          </div>

          <div className="flex gap-3 mt-6">
            <Link
              href="/login?role=customer"
              className="btn btn-primary flex-1 text-center"
            >
              Back to Sign In
            </Link>
          </div>
        </div>
      </div>
      <p className="text-center text-xs text-slate-400 mt-8">
        Built by BloomCore Technologies
      </p>
    </div>
  );
}
