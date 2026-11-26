/**
 * Node-only background maintenance.
 *
 * This module is imported dynamically from `instrumentation.ts` only when the
 * runtime is the Node.js server. Keeping it separate is what allows the edge
 * compilation of the instrumentation hook to stay free of native database
 * drivers (Prisma 7 uses node-postgres / better-sqlite3 adapters).
 */

import fs from "node:fs";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { assertEmailConfigurationForProduction } from "./lib/email/resend";
import { assertTurnstileConfigurationForProduction } from "./lib/security/config";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BILLING_INTERVAL_MS = 60 * 60 * 1000;

let started = false;

/**
 * Local, synthetic-only memory/GC sampler. It is gated to the isolated load
 * runtime and writes aggregate numbers to a file inside the test artifact
 * directory. No production data, credential or heap snapshot is written.
 */
function startLocalMemorySampler(): void {
  if (
    process.env.APP_ENV !== "LOCAL_LOAD_TEST" ||
    process.env.MAACASH_LOAD_MEM_SAMPLE !== "1" ||
    !process.env.MAACASH_LOAD_MEM_OUT
  ) {
    return;
  }
  const out = process.env.MAACASH_LOAD_MEM_OUT;
  const allowedRoot = path.resolve(process.cwd(), "tests");
  const resolved = path.resolve(out);
  if (!resolved.startsWith(allowedRoot + path.sep)) return;
  const gcDurations: number[] = [];
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcDurations.push(Number(entry.duration.toFixed(3)));
        if (gcDurations.length > 500) gcDurations.shift();
      }
    });
    observer.observe({ type: "gc", buffered: true });
  } catch {
    // GC entries require --expose-gc; RSS/heap sampling still works.
  }
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    const activeHandles = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.().length ?? null;
    fs.appendFileSync(
      resolved,
      JSON.stringify({
        at: new Date().toISOString(),
        rssMb: Number((m.rss / 1048576).toFixed(1)),
        heapUsedMb: Number((m.heapUsed / 1048576).toFixed(1)),
        heapTotalMb: Number((m.heapTotal / 1048576).toFixed(1)),
        externalMb: Number((m.external / 1048576).toFixed(1)),
        arrayBuffersMb: Number((m.arrayBuffers / 1048576).toFixed(1)),
        activeHandles,
        gcCount: gcDurations.length,
        gcMaxMs: gcDurations.length ? Math.max(...gcDurations) : null,
      }) + "\n"
    );
  }, 2000);
  timer.unref();
}
startLocalMemorySampler();

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

/**
 * Durable, metadata-only audit for every Risk Intelligence key access. The
 * process-local history is useful for diagnostics but is not evidence; this
 * sink persists one audit row without the key, salt, input or hash output.
 */
async function installRiskSecretAccessAudit(): Promise<void> {
  const [{ setRiskSecretAccessSink }, { createAuditLog }] = await Promise.all([
    import("./lib/risk-intelligence/secret-provider"),
    import("./lib/audit"),
  ]);
  setRiskSecretAccessSink((metadata) => {
    void createAuditLog({
      userId: "system:risk_secret_access",
      action: "risk_intelligence.secret_access",
      entityType: "riskKeyVersion",
      entityId: String(metadata.version),
      details: {
        version: metadata.version,
        providerId: metadata.providerId,
        operation: metadata.operation,
        outcome: metadata.outcome,
        at: metadata.at,
        financialMutation: false,
      },
    }).catch((error) => {
      const name = error instanceof Error ? error.name : "UnknownError";
      console.error("[risk-secret-audit] write failed", name);
    });
  });
}

/** Start the periodic maintenance sweep once per Node.js server instance. */
export function startBackgroundSweeps(): void {
  if (process.env.VITEST) return;

  // Install before any sweep or request can touch a risk key. A failure is
  // logged by class only and does not disable the application; the in-process
  // history still records access while the operator fixes the sink.
  void installRiskSecretAccessAudit().catch((error) => {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[risk-secret-audit] install failed", name);
  });

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
