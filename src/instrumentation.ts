/**
 * Zeli lifecycle scheduler.
 *
 * Next.js calls `register()` once per server instance, before the server
 * handles requests. The sweep is started here so lapsed access closes even when
 * no tenant is browsing, and an immediate catch-up covers downtime.
 *
 * The timer is unref'd: it never keeps a process alive on its own, so builds,
 * tests and short-lived workers can still exit. Failures are logged by name and
 * never crash the server: a background sweep must not take production down.
 */

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

import { assertEmailConfigurationForProduction } from "./lib/email/resend";

function sweepInterval(): number {
  const configured = Number(process.env.ZELI_EXPIRY_INTERVAL_MS ?? "");
  return Number.isFinite(configured) && configured >= 60_000 ? configured : SWEEP_INTERVAL_MS;
}

let started = false;
let timer: NodeJS.Timeout | null = null;

async function runSweep(): Promise<void> {
  try {
    const { expireZeliLifecycle } = await import("./lib/zeli/expiry");
    const counts = await expireZeliLifecycle();
    const { db } = await import("./lib/db");
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.stepUpGrant.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    await db.sessionRecord.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    await db.mfaChallengeUse.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    await db.tabProofNonce.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    await db.tabCredential.deleteMany({
      where: { lastUsedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    });
    console.info("[zeli-expiry] sweep completed", counts);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[zeli-expiry] sweep failed", name);
  }
}

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // SEC-16: fail the boot when transactional email is deliberately disabled or
  // required sender configuration is missing. Scope to the actual Render
  // production service so CI/E2E `next start` runs are not mistaken for
  // production. A transient provider outage later never crashes the app.
  if (process.env.NODE_ENV === "production" && process.env.RENDER === "true") {
    assertEmailConfigurationForProduction();
  }
  if (process.env.VITEST) return;
  if (process.env.ZELI_EXPIRY_SCHEDULER === "disabled") return;
  if (started) return;

  started = true;

  // Catch-up run for anything that lapsed while the process was down.
  void runSweep();

  timer = setInterval(() => {
    void runSweep();
  }, sweepInterval());
  timer.unref();
}
