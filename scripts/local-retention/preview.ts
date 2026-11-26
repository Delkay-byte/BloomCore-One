/**
 * Read-only retention preview.
 *
 * Invoked only by `node scripts/run-risk-retention-cron.mjs --dry-run`.
 *
 * This module uses the SAME date arithmetic as the production sweep by
 * importing src/lib/risk-intelligence/retention.ts directly. It performs only
 * Prisma `findMany` / `findFirst` / `count` reads. It never calls the retention
 * route, never reads RISK_RETENTION_TOKEN, and never issues a write.
 *
 * SQLite is opened with `readonly: true, fileMustExist: true`, so the driver
 * refuses any write. Postgres is opened with `default_transaction_read_only=on`
 * and requires an explicit deliberate-selection flag.
 *
 * Output: aggregate counts only. No URL, token, row value or identifier is
 * printed. Error messages are sanitised before printing.
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  legalHoldDeadline,
  legalHoldReviewDue,
  riskAuditDeletionDeadline,
  signalDeletionDeadline,
  type LegalHoldState,
} from "../../src/lib/risk-intelligence/retention";

const BATCH_LIMIT = 500;

function fail(message: string): never {
  console.error(`[risk-retention-preview] ${message}`);
  process.exit(1);
}

/** Strip URLs, paths and long secrets from any diagnostic text. */
function sanitise(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/\b(?:[A-Za-z]:)?[\\/][^\s"']+/g, "[redacted-path]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-secret]");
}

function generatedProvider(): string | null {
  try {
    const schema = fs.readFileSync(
      path.join(process.cwd(), "node_modules", ".prisma", "client", "schema.prisma"),
      "utf8"
    );
    const datasource = schema.slice(schema.indexOf("datasource"));
    return /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** True when an active hold still defers the deadline beyond `now`. */
function holdDefersDeletion(
  deadline: string,
  hold: LegalHoldState | null,
  now: Date
): boolean {
  if (!hold?.active) return false;
  const effective = legalHoldDeadline(deadline, hold);
  return effective === null || new Date(effective).getTime() > now.getTime();
}

async function main(): Promise<void> {
  const rawUrl = (process.env.RETENTION_PREVIEW_DATABASE_URL ?? "").trim();
  if (!rawUrl) fail("RETENTION_PREVIEW_DATABASE_URL is not configured.");

  const isFile = rawUrl.startsWith("file:");
  const isPostgres =
    rawUrl.startsWith("postgresql://") || rawUrl.startsWith("postgres://");
  if (!isFile && !isPostgres) {
    fail("preview target must be a file: SQLite URL or a postgres URL.");
  }
  if (isPostgres && process.env.RETENTION_PREVIEW_ALLOW_PRODUCTION !== "1") {
    fail("postgres preview requires RETENTION_PREVIEW_ALLOW_PRODUCTION=1 (deliberate selection).");
  }

  const expectedProvider = isFile ? "sqlite" : "postgresql";
  const currentProvider = generatedProvider();
  if (currentProvider !== expectedProvider) {
    const command = isFile ? "npm run db:generate" : "npm run db:generate:pg";
    fail(
      `generated Prisma client does not match preview provider; run ${command} first, then retry.`
    );
  }

  const adapter = isFile
    ? new PrismaBetterSqlite3({
        url: rawUrl.split("?")[0] ?? "",
        readonly: true,
        fileMustExist: true,
      })
    : new PrismaPg({
        connectionString: rawUrl,
        options: "-c default_transaction_read_only=on",
      } as never);

  const db = new PrismaClient({ adapter: adapter as never });

  try {
    const now = new Date();

    // Mirrors executeRetentionSweep's expiry predicate. `count` is read-only.
    const expiredCandidates = await db.agentRiskSignal.count({
      where: { status: "open", expiresAt: { lte: now }, deletedAt: null },
    });

    // Mirrors the 500-row signal scrub batch and its legal-hold checks. The
    // sweep expires due `open` rows BEFORE this query, so include them here in
    // read-only form; otherwise the ordered 500-row window shifts by one row.
    const rows = await db.agentRiskSignal.findMany({
      where: {
        deletedAt: null,
        OR: [
          { status: { in: ["expired", "withdrawn", "disputed_frozen", "frozen"] } },
          { status: "open", expiresAt: { lte: now } },
        ],
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        withdrawnAt: true,
        resolvedAt: true,
        subjectKey: true,
        tenantId: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_LIMIT,
    });

    async function activeHold(
      scopeType: string,
      scopeId: string,
      tenantId: string | null
    ): Promise<LegalHoldState | null> {
      const hold = await db.riskLegalHold.findFirst({
        where: {
          scopeType,
          scopeId,
          releasedAt: null,
          ...(tenantId ? { tenantId } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: { extensionUntil: true },
      });
      if (!hold) return null;
      return {
        active: true,
        extensionUntil: hold.extensionUntil?.toISOString() ?? null,
      };
    }

    let scrubCandidates = 0;
    let holdsSkipped = 0;
    for (const row of rows) {
      const deadline = signalDeletionDeadline({
        status: row.status === "open" ? "expired" : row.status,
        expiresAt: row.expiresAt.toISOString(),
        withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
      });
      if (!deadline || new Date(deadline).getTime() > now.getTime()) continue;

      const signalHold = await activeHold("signal", row.id, row.tenantId);
      const subjectHold = await activeHold("subject", row.subjectKey, row.tenantId);
      if (
        holdDefersDeletion(deadline, signalHold, now) ||
        holdDefersDeletion(deadline, subjectHold, now)
      ) {
        holdsSkipped += 1;
        continue;
      }
      scrubCandidates += 1;
    }

    // Mirrors the 500-row disclosure de-identification batch.
    const disclosures = await db.riskIntelligenceDisclosure.findMany({
      where: { deletedAt: null },
      select: { id: true, createdAt: true },
      orderBy: { id: "asc" },
      take: BATCH_LIMIT,
    });
    let auditCandidates = 0;
    for (const disclosure of disclosures) {
      const deadline = riskAuditDeletionDeadline(disclosure.createdAt.toISOString());
      if (new Date(deadline).getTime() <= now.getTime()) auditCandidates += 1;
    }

    // The real sweep also creates review-due control events. Surface the count.
    const openHolds = await db.riskLegalHold.findMany({
      where: { releasedAt: null, caseClosureDate: { not: null } },
      select: { caseClosureDate: true, releasedAt: true },
    });
    let legalHoldReviewCandidates = 0;
    const nowIso = now.toISOString();
    for (const hold of openHolds) {
      if (!hold.caseClosureDate) continue;
      if (
        legalHoldReviewDue(
          hold.caseClosureDate.toISOString(),
          nowIso,
          hold.releasedAt?.toISOString() ?? null
        )
      ) {
        legalHoldReviewCandidates += 1;
      }
    }

    console.info(
      "[risk-retention-preview] ok " +
        JSON.stringify({
          mode: "preview-read-only",
          provider: expectedProvider,
          at: nowIso,
          expiredCandidates,
          scrubCandidates,
          auditCandidates,
          holdsSkipped,
          legalHoldReviewCandidates,
          scrubBatchLimited: rows.length === BATCH_LIMIT,
          auditBatchLimited: disclosures.length === BATCH_LIMIT,
        })
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.name : "UnknownError";
  const raw = error instanceof Error ? error.message : "";
  const extra = raw ? ` (${sanitise(raw).slice(0, 300)})` : "";
  fail(`preview failed (${detail})${extra}.`);
});
