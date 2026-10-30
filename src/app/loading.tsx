import { PageSkeleton } from "@/components/ui/DataDisplay";

export default function Loading() {
  return (
    <div className="min-h-[60vh] flex items-start justify-center px-4 pt-10">
      <div className="w-full max-w-5xl">
        <PageSkeleton />
      </div>
    </div>
  );
}
