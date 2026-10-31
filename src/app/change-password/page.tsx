"use client";

import ChangePasswordForm from "@/components/ChangePasswordForm";

export default function ChangePasswordPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="card">
          <h1 className="text-xl font-bold mb-6">Change Password</h1>
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
