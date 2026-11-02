import { SkeletonPage } from "@/components/ui/Skeletons";

export default function PlatformConsoleLoading() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <SkeletonPage variant="table" />
    </div>
  );
}
