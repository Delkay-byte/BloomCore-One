"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function CustomerLoginRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("role", "customer");
    router.replace(`/login?${params.toString()}`);
  }, [router, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 via-indigo-50 to-amber-50 px-4">
      <div className="card text-center p-8 max-w-md">
        <div className="spinner mx-auto mb-4"></div>
        <p className="text-slate-600">Redirecting to Customer Portal...</p>
      </div>
    </div>
  );
}