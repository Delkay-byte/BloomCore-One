import Database from "better-sqlite3";
import { e2eDatabase } from "../scripts/test-database-paths.cjs";

/**
 * Restores the platform-wide Zeli availability switch.
 *
 * The master-switch browser test turns Zeli off for every tenant, so a failure
 * halfway through it would otherwise leave the switch off and cascade into every
 * later spec that expects Zeli to be reachable. This repair runs against the
 * same disposable E2E database the suite uses, resolved through the same helper,
 * which refuses any path that is not a disposable test database.
 */
export function restoreGlobalZeliAvailability(reason: string): void {
  const { file } = e2eDatabase();
  const connection = new Database(file);
  try {
    const row = connection
      .prepare('SELECT enabled FROM "ZeliAvailability" WHERE id = ?')
      .get("global") as { enabled: number | bigint } | undefined;
    const now = new Date().toISOString();
    if (!row) {
      connection
        .prepare(
          'INSERT INTO "ZeliAvailability" (id, enabled, reason, createdAt, updatedAt) VALUES (?, 1, ?, ?, ?)'
        )
        .run("global", reason, now, now);
      return;
    }
    if (Number(row.enabled) === 1) return;
    connection
      .prepare(
        'UPDATE "ZeliAvailability" SET enabled = 1, reason = ?, updatedAt = ? WHERE id = ?'
      )
      .run(reason, now, "global");
  } finally {
    connection.close();
  }
}
