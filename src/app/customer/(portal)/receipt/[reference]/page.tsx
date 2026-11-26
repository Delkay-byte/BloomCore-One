"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SkeletonPage } from "@/components/ui/Skeletons";
import Notice from "@/components/ui/Notice";
import SusuReceiptDocument from "@/components/susu/SusuReceiptDocument";
import { getCustomerReceipt } from "@/lib/actions/susu-customer.actions";
import type { SusuReceipt } from "@/lib/susu-statements";

export default function CustomerReceiptPage() {
  const params = useParams<{ reference: string }>();
  const reference = params?.reference ?? "";
  const [receipt, setReceipt] = useState<SusuReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setReceipt(await getCustomerReceipt(decodeURIComponent(reference)));
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
          {error || "This receipt was not found on your account."}
        </Notice>
        <Link href="/customer/statement" className="btn btn-secondary inline-flex">
          Back to statement
        </Link>
      </div>
    );
  }

  return (
    <SusuReceiptDocument
      receipt={receipt}
      backHref="/customer/statement"
      disputeHref={`/customer/disputes/new?type=${receipt.kind}&id=${encodeURIComponent(
        receipt.subjectId
      )}`}
    />
  );
}
