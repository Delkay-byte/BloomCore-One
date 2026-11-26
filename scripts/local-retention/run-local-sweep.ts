/**
 * Local-only harness for the REAL retention actions against a disposable
 * SQLite database. Never used by the production cron path.
 *
 * DATABASE_URL must point at a disposable synthetic SQLite file.
 * RISK_RETENTION_TOKEN must hold a synthetic value. Neither value is printed.
 *
 * Modes:
 *   system      runSystemRiskRetentionSweep with the configured token
 *   expire      expireStaleRiskSignals with the configured token
 *   forbidden   runSystemRiskRetentionSweep with a deliberately wrong token
 *   concurrent  two simultaneous runSystemRiskRetentionSweep calls
 */

import {
  runSystemRiskRetentionSweep,
} from "../../src/lib/actions/risk-governance.actions";
import { expireStaleRiskSignals } from "../../src/lib/actions/risk-intelligence.actions";

const mode = process.argv[2] ?? "system";
const token = process.env.RISK_RETENTION_TOKEN ?? "";

async function main(): Promise<void> {
  let result: unknown;
  if (mode === "system") {
    result = await runSystemRiskRetentionSweep({ token });
  } else if (mode === "expire") {
    result = await expireStaleRiskSignals({ token });
  } else if (mode === "forbidden") {
    result = await runSystemRiskRetentionSweep({ token: `${token}-wrong` });
  } else if (mode === "concurrent") {
    result = {
      results: await Promise.all([
        runSystemRiskRetentionSweep({ token }),
        runSystemRiskRetentionSweep({ token }),
      ]),
    };
  } else {
    throw new Error("unknown local sweep mode");
  }
  console.info(`[local-sweep] ${mode} ${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  const safe = message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/\b(?:[A-Za-z]:)?[\\/][^\s"']+/g, "[redacted-path]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-secret]");
  console.error(`[local-sweep] ${mode} failed (${name}): ${safe.slice(0, 400)}`);
  process.exit(1);
});
