/**
 * CLI entrypoint for the Zeli lifecycle expiry sweep.
 *
 * Usage: npm run zeli:expire
 *
 * Prints only the counts of rows changed. It never prints tenant or
 * subscription contents. Exit code 1 signals a failed sweep.
 */

import { db } from "../src/lib/db";
import { expireZeliLifecycle } from "../src/lib/zeli/expiry";

async function main(): Promise<void> {
  const result = await expireZeliLifecycle();
  console.log(
    `zeli-expire: subscriptions=${result.subscriptions} entitlements=${result.entitlements} skipped=${result.skipped}`
  );
}

main()
  .catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`zeli-expire: sweep failed (${name})`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
