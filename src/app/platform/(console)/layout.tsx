import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import PlatformShell from "../PlatformShell";

export const dynamic = "force-dynamic";

// Console layout for /platform/* except the public /platform/login. Every page
// here is behind the platform session; a first-login password change is forced
// through /platform/settings before any operator page renders.
export default async function PlatformConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePlatformAdmin();
  if (session.forcePasswordReset) {
    redirect("/platform/settings?tab=password");
  }
  return <PlatformShell session={session}>{children}</PlatformShell>;
}
