import Database from "better-sqlite3";
import { e2eDatabase } from "../scripts/test-database-paths.cjs";

/**
 * Clears any message-delivery settings the browser suite wrote.
 *
 * The switches are business-wide, so a run that left WhatsApp enabled would
 * change what other specs could send. Only the disposable E2E database is
 * touched, resolved through the shared helper that refuses anything else.
 */
export function restoreMessagingConfig(): void {
  const { file } = e2eDatabase();
  const connection = new Database(file);
  try {
    for (const table of [
      "TenantMessagingConfig",
      "MessagingTemplate",
      "MessagingConsentChallenge",
    ]) {
      const exists = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (exists) connection.prepare(`DELETE FROM "${table}"`).run();
    }
    // The customer's opt-in is part of the same fixture: without it the seeded
    // preference stays verified and the "ask for a code" path cannot be shown.
    connection
      .prepare(
        'UPDATE "CustomerMessagingPreference" SET whatsappNumber = NULL, whatsappStatus = \'unverified\', whatsappOptInAt = NULL, whatsappVerifiedAt = NULL WHERE whatsappNumber = ?'
      )
      .run("+233200000999");
  } finally {
    connection.close();
  }
}
