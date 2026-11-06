import { getZeliAvailability } from "@/lib/zeli/availability";
import ZeliUnavailable from "@/components/zeli/ZeliUnavailable";

export const dynamic = "force-dynamic";

/**
 * Server-side gate for the entire conversational workspace. A tenant-facing
 * page must not render Zeli content while the global master switch is OFF.
 * APIs and actions enforce the same switch independently.
 */
export default async function ZeliLayout({ children }: { children: React.ReactNode }) {
  const availability = await getZeliAvailability();
  if (!availability.enabled) {
    return (
      <div className="min-h-screen bg-[#F6F5EC] px-4">
        <ZeliUnavailable reason={availability.reason} />
      </div>
    );
  }
  return <>{children}</>;
}
