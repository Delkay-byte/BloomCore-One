import { redirect } from "next/navigation";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import PlatformLoginForm from "./PlatformLoginForm";

export const dynamic = "force-dynamic";

// The platform login is its own security boundary. An operator with a valid
// platform session goes straight to the dashboard; tenant sessions are never
// consulted here and can never authenticate this route.
export default async function PlatformLoginPage() {
  const session = await getPlatformAdminOrNull();
  if (session) {
    redirect(session.forcePasswordReset ? "/platform/settings?tab=password" : "/platform/dashboard");
  }
  return <PlatformLoginForm />;
}
