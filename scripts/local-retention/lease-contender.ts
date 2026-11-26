/**
 * Synthetic cross-process lease contender used by the F5 regression test.
 * Prints a single compact JSON line. No secret value is printed.
 */
import { createPrismaClient } from "../../src/lib/prisma-client";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (
    !url ||
    !/^(file:|postgres(?:ql)?:\/\/localhost|postgres(?:ql)?:\/\/127\.0\.0\.1)/i.test(url)
  ) {
    throw new Error("Lease contender requires an explicitly local disposable DATABASE_URL.");
  }

  const db = createPrismaClient(url);
  // Independent implementation of the claim rule, applied to the same shared
  // database with an identical atomic UPDATE/P2002 strategy.
  const key = "risk_retention_sweep";
  const now = new Date();
  const ownerId = crypto.randomUUID();
  let acquired = false;
  try {
    await db.systemJobLease.create({
      data: {
        key,
        ownerId,
        fencingToken: 0,
        status: "running",
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    });
    acquired = true;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const claimed = await db.systemJobLease.updateMany({
      where: { key, OR: [{ status: "released" }, { expiresAt: { lte: now } }] },
      data: {
        ownerId,
        status: "running",
        fencingToken: { increment: 1 },
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        releasedAt: null,
        lastOutcome: null,
      },
    });
    acquired = claimed.count === 1;
  }

  console.log(JSON.stringify({ acquired, ownerId }));
  if (acquired) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await db.systemJobLease.updateMany({
      where: { key, ownerId, status: "running" },
      data: { status: "released", releasedAt: new Date(), lastOutcome: "success" },
    });
  }
  await db.$disconnect();
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
