"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { SkeletonPage } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";
import SusuReceiptDocument from "@/components/susu/SusuReceiptDocument";
import { getAdminSusuReceipt } from "@/lib/actions/susu-customer.actions";
import type { SusuReceipt } from "@/lib/susu-statements";

export default function AdminSusuReceiptPage() {
  const params = useParams<{ reference: string }>();
  const router = useRouter();
  const reference = params?.reference ?? "";
  const [receipt, setReceipt] = useState<SusuReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReceipt(await getAdminSusuReceipt(decodeURIComponent(reference)));
    } catch {
      setError("This receipt could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [reference]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonPage variant="detail" />;

  if (!receipt) {
    return (
      <div className="space-y-4">
        <Notice type="error">
          {error || "This receipt does not belong to your business."}
        </Notice>
        <button type="button" className="btn btn-secondary" onClick={() => router.back()}>
          Go back
        </button>
      </div>
    );
  }

  return <SusuReceiptDocument receipt={receipt} />;
}
