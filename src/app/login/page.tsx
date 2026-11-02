import { Suspense } from "react";
import UnifiedLoginClient from "./UnifiedLoginClient";
import { SkeletonPage } from "@/components/ui/Skeletons";

export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center px-4"><div className="w-full max-w-md"><SkeletonPage variant="form" /></div></div>}>
      <UnifiedLoginClient searchParams={searchParams} />
    </Suspense>
  );
}