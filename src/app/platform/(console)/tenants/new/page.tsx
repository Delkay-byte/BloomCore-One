import { requirePlatformPage } from "@/lib/platform-auth";
import EnrollTenantWizard from "./EnrollTenantWizard";

export const dynamic = "force-dynamic";

export default async function PlatformEnrollPage() {
  await requirePlatformPage();
  return <EnrollTenantWizard />;
}
