import { Suspense } from "react";
import ForgotPasswordClient from "./ForgotPasswordClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100" />}>
      <ForgotPasswordClient />
    </Suspense>
  );
}
