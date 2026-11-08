import { db } from "@/lib/db";
import { requireTenantCustomer } from "@/lib/tenant";
import CustomerShell from "./CustomerShell";

/**
 * Customer portal layout. Identity and the Susu business name are resolved from
 * the verified customer session on the server.
 */
export default async function CustomerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireTenantCustomer();
  const customer = await db.customer.findUnique({
    where: { id: ctx.userId },
    select: { fullName: true },
  });

  return (
    <CustomerShell
      fullName={customer?.fullName ?? "Customer"}
      tenantName={ctx.tenantName}
    >
      {children}
    </CustomerShell>
  );
}
