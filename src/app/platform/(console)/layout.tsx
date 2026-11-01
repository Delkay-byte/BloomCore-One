import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import PlatformShell from "../PlatformShell";

export const dynamic = "force-dynamic";

// Console layout for /platform/* except the public /platform/login and the
// standalone /platform/first-login. Every page here is behind the platform
// session; a first-login password change is forced to the standalone screen
// before any operator page renders — never to a page this layout wraps.
export default async function PlatformConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePlatformAdmin();
  if (session.forcePasswordReset) {
    redirect("/platform/first-login");
  }
  return <PlatformShell session={session}>{children}</PlatformShell>;
}
