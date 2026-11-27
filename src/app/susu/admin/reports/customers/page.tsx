import { getCustomerStatement } from "@/lib/actions/susu-reporting.actions";
import CediAmount from "@/components/CediAmount";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SusuCustomersReportPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string; dateFrom?: string; dateTo?: string }>;
}) {
  const { accountId, dateFrom, dateTo } = await searchParams;
  const result = await getCustomerStatement(accountId ?? "", {
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const data = result.success ? result.data : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Susu Customer Statement</h1>
          <p className="text-slate-500 mt-1">Per-account contribution, withdrawal and balance history</p>
        </div>
      </div>

      {!result.success ? (
        <div className="card">
          <p className="text-center py-12 text-slate-500">{result.error ?? "Statement unavailable"}</p>
        </div>
      ) : !data ? (
        <div className="card">
          <p className="text-center py-12 text-slate-500">No statement data available.</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold mb-2">Account</h2>
            <p className="text-sm text-slate-500">
              {data.account?.fullName ?? ""} · Account ID {data.account?.accountId ?? ""} · Customer {data.account?.customerId ?? ""} · Status {data.account?.status ?? ""}
            </p>
            {data.cycle ? (
              <p className="text-sm text-slate-500 mt-1">
                Cycle #{data.cycle.cycleNumber} · {formatDate(data.cycle.startDate)} to {formatDate(data.cycle.endDate)}
              </p>
            ) : null}
          </div>

          <div className="card">
            <h2 className="text-lg font-semibold mb-4">Entries</h2>
            {data.entries?.length === 0 ? (
              <p className="text-center py-12 text-slate-500">No statement entries for this period.</p>
            ) : (
              <div className="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Credit</th>
                      <th>Debit</th>
                      <th>Balance</th>
                      <th>Reference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries?.map((entry, index) => (
                      <tr key={`${entry.referenceId}-${index}`}>
                        <td className="text-sm">{formatDate(entry.date)}</td>
                        <td className="text-sm">{entry.kind}</td>
                        <td className="font-mono"><CediAmount amount={entry.credit} /></td>
                        <td className="font-mono"><CediAmount amount={entry.debit} /></td>
                        <td className="font-mono font-semibold"><CediAmount amount={entry.balance} /></td>
                        <td className="text-sm">{entry.referenceId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.summary ? (
              <p className="mt-4 text-sm text-slate-500">
                Credits <CediAmount amount={data.summary.credits} /> · Debits <CediAmount amount={data.summary.debits} /> · Closing balance <CediAmount amount={data.summary.closingBalance} />
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
