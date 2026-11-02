import { Suspense } from "react";
import CustomerLoginRedirect from "./CustomerLoginRedirect";

export default function CustomerLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
          <p className="text-slate-500 text-sm" role="status">
            Opening customer sign in…
          </p>
        </div>
      }
    >
      <CustomerLoginRedirect />
    </Suspense>
  );
}
