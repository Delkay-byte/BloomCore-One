import { Suspense } from "react";
import ResetPasswordClient from "./ResetPasswordClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password" };

export default function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100" />}>
      <ResetPasswordClient searchParams={searchParams} />
    </Suspense>
  );
}
