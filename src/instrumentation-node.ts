/**
 * Node-only background maintenance.
 *
 * This module is imported dynamically from `instrumentation.ts` only when the
 * runtime is the Node.js server. Keeping it separate is what allows the edge
 * compilation of the instrumentation hook to stay free of native database
 * drivers (Prisma 7 uses node-postgres / better-sqlite3 adapters).
 */

import { assertEmailConfigurationForProduction } from "./lib/email/resend";
import { assertTurnstileConfigurationForProduction } from "./lib/security/config";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BILLING_INTERVAL_MS = 60 * 60 * 1000;

let started = false;

/**
 * Boot-time configuration preflight (SEC-16 / SEC-11). Kept here rather than in
 * `instrumentation.ts` so the edge compilation never sees node:crypto.
 */
function runBootPreflight(): void {
  if (process.env.NODE_ENV !== "production" || process.env.RENDER !== "true") {
    return;
  }
  assertEmailConfigurationForProduction();
  assertTurnstileConfigurationForProduction();
}
let timer: NodeJS.Timeout | null = null;
let lastRetentionAt = 0;
let lastBillingAt = 0;

function sweepInterval(): number {
  const configured = Number(process.env.ZELI_EXPIRY_INTERVAL_MS ?? "");
  return Number.isFinite(configured) && configured >= 60_000 ? configured : SWEEP_INTERVAL_MS;
}

/**
 * Residual C: apply the approved 365-day security-event retention policy at
 * most once a day per instance. Financial audit tables are never touched.
 */
async function runSecurityRetention(): Promise<void> {
  const now = Date.now();
  if (now - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  lastRetentionAt = now;
  const { pruneSecurityEvents } = await import("./lib/security/events");
  const counts = await pruneSecurityEvents(new Date(now));
  console.info("[security-retention] pruned", counts);
}

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
    await runSecurityRetention();
    await runBillingMaintenance();
  } catch (error) {
    // Log only the error class and Prisma error code: no identifiers, no
    // personal data, but enough for an operator to tell a schema problem
    // (P2021/P2022) from a transient connection failure.
    const name = error instanceof Error ? error.name : "UnknownError";
    const code = (error as { code?: unknown }).code;
    console.error(
      "[zeli-expiry] sweep failed",
      name,
      typeof code === "string" ? code : "no-code"
    );
  }
}

/**
 * Billing lifecycle, reminders and pending-payment reconciliation. Runs hourly
 * (and on boot) so reminders never depend on an administrator opening a page.
 * The reconciliation is bounded to ten references per run and only a verified
 * provider answer can activate a subscription.
 */
async function runBillingMaintenance(): Promise<void> {
  const now = Date.now();
  if (now - lastBillingAt < BILLING_INTERVAL_MS) return;
  lastBillingAt = now;
  const { runBillingLifecycle, reconcilePendingPayments } = await import("./lib/billing/lifecycle");
  const lifecycle = await runBillingLifecycle();
  const reconciled = await reconcilePendingPayments();
  console.info("[billing] lifecycle", lifecycle, "reconciled", reconciled);
}

/** Start the periodic maintenance sweep once per Node.js server instance. */
export function startBackgroundSweeps(): void {
  if (process.env.VITEST) return;

  // Fail the boot before anything else starts when production configuration is
  // incomplete. This must run even if the sweep scheduler is disabled.
  runBootPreflight();

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
