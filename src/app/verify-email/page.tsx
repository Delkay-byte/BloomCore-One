import { Suspense } from "react";
import VerifyEmailClient from "./VerifyEmailClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verify email" };

export default function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>;
}) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <VerifyEmailClient searchParams={searchParams} />
    </Suspense>
  );
}
