/**
 * Per-account transaction lock.
 *
 * PostgreSQL READ COMMITTED does not prevent two concurrent withdrawals from
 * reading the same balance and both posting. A transaction-scoped advisory lock
 * keyed on the account serialises every balance-changing operation for that
 * account until the surrounding transaction commits or rolls back.
 *
 * SQLite serialises writers itself, so the lock is a no-op there.
 */
export function isPostgres(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("postgres");
}

export async function lockAccountForUpdate(
  tx: { $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> },
  accountId: string
): Promise<void> {
  if (!isPostgres()) return;
  // The lock function returns void, which Prisma cannot deserialize; cast it.
  await tx.$queryRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))::text",
    accountId
  );
}
