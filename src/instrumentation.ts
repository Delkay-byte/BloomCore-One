/**
 * Next.js server instrumentation.
 *
 * Only a runtime guard lives here. Every Node-only concern (configuration
 * preflight and database-backed background maintenance) is loaded from
 * `instrumentation-node.ts` through a dynamic import that the edge compilation
 * ignores, so native database drivers never enter the edge bundle.
 */

export function register(): void | Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // The import is unreachable on edge: it sits behind the guard above, and
  // next.config.ts drops the module from the edge graph. Returning the promise
  // lets Next (and the scheduler tests) await the Node-only maintenance module.
  return import("./instrumentation-node").then((module) => {
    module.startBackgroundSweeps();
  });
}
