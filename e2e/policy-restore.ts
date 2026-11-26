import Database from "better-sqlite3";
import { e2eDatabase } from "../scripts/test-database-paths.cjs";

/**
 * Clears any operational policy the browser suite wrote.
 *
 * The policy is business-wide: a run that leaves "shifts required" behind would
 * refuse every later daily close in the same fixture, so the switch is returned
 * to the product defaults after the policy spec, whether it passed or failed.
 *
 * This touches only the disposable E2E database, resolved through the shared
 * helper that refuses anything that is not a disposable test database.
 */
export function restoreOperationalPolicy(): void {
  const { file } = e2eDatabase();
  const connection = new Database(file);
  try {
    const table = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("TenantOperationalPolicy");
    if (!table) return;
    connection.prepare('DELETE FROM "TenantOperationalPolicy"').run();
  } finally {
    connection.close();
  }
}
