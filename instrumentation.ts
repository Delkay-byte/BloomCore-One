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

function sweepInterval(): number {
  const configured = Number(process.env.ZELI_EXPIRY_INTERVAL_MS ?? "");
  return Number.isFinite(configured) && configured >= 60_000 ? configured : SWEEP_INTERVAL_MS;
}

let started = false;
let timer: NodeJS.Timeout | null = null;

async function runSweep(): Promise<void> {
  try {
    const { expireZeliLifecycle } = await import("./src/lib/zeli/expiry");
    const counts = await expireZeliLifecycle();
    console.info("[zeli-expiry] sweep completed", counts);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[zeli-expiry] sweep failed", name);
  }
}

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
