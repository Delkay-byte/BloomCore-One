import { SkeletonPage } from "@/components/ui/Skeletons";

export default function CustomerPortalLoading() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <SkeletonPage variant="dashboard" />
    </div>
  );
}
