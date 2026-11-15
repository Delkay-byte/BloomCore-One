import { Suspense } from "react";
import ChangePasswordPageClient from "../change-password/ChangePasswordPageClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password" };

/**
 * Public challenge-only password upgrade screen.
 *
 * It is separate from /change-password (which stays session-protected) because
 * the mandatory upgrade happens before any session exists.
 */
export default function PasswordUpgradePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <ChangePasswordPageClient searchParams={Promise.resolve({ required: "1" })} />
    </Suspense>
  );
}
