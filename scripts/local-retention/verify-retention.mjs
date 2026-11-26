/**
 * Local-only retention verification against disposable synthetic SQLite data.
 *
 * No production access. No HTTP calls to the retention route. No secrets.
 * Creates temp databases under the OS temp directory with a disposable name,
 * enforced by scripts/test-database-paths.cjs.
 *
 * Run: node scripts/local-retention/verify-retention.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  assertDisposableDatabase,
  sqliteUrlFor,
} from "../test-database-paths.cjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRON = path.join(REPO_ROOT, "scripts", "run-risk-retention-cron.mjs");
const PRISMA_CLI = path.join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SWEEP_HELPER = path.join(REPO_ROOT, "scripts", "local-retention", "run-local-sweep.ts");
const ARITHMETIC = path.join(REPO_ROOT, "scripts", "local-retention", "check-date-arithmetic.ts");
const EVIDENCE = path.join(REPO_ROOT, "tests", "local-retention-evidence.json");

const DAY = 86_400_000;
const SYNTHETIC_TOKEN = "local-synthetic-retention-token-not-a-secret";
const checks = [];
const results = {};

function check(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition), detail: detail ?? null });
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) {
    if (detail !== undefined) console.error(JSON.stringify(detail));
    throw new Error(`check failed: ${name}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function ensureSqliteClient() {
  const schemaPath = path.join(REPO_ROOT, "node_modules", ".prisma", "client", "schema.prisma");
  let provider = null;
  try {
    const schema = fs.readFileSync(schemaPath, "utf8");
    const datasource = schema.slice(schema.indexOf("datasource"));
    provider = /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? null;
  } catch {
    provider = null;
  }
  if (provider === "sqlite") return;
  execFileSync(
    process.execPath,
    [PRISMA_CLI, "generate", "--schema=prisma/schema.prisma"],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env }
  );
}

function makeDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode", `retention-${label}-`));
  const file = assertDisposableDatabase(path.join(dir, "test.db"));
  const url = sqliteUrlFor(file);
  execFileSync(
    process.execPath,
    [PRISMA_CLI, "db", "push", "--schema=prisma/schema.prisma"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
      encoding: "utf8",
    }
  );
  return { file, url };
}

function openWrite(file) {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  return db;
}

function snapshot(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const count = (table) => db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
  const counts = {
    signals: count("AgentRiskSignal"),
    disclosures: count("RiskIntelligenceDisclosure"),
    holds: count("RiskLegalHold"),
    auditLogs: count("AuditLog"),
    controlEvents: count("RiskControlEvent"),
  };
  const dump = JSON.stringify({
    signals: db
      .prepare(
        "SELECT id,status,subjectKey,internalNote,sourceId,expiresAt,withdrawnAt,resolvedAt,deletedAt,scrubbedAt FROM AgentRiskSignal ORDER BY id"
      )
      .all(),
    disclosures: db
      .prepare("SELECT id,subjectKey,createdAt,deletedAt FROM RiskIntelligenceDisclosure ORDER BY id")
      .all(),
    holds: db.prepare("SELECT id,releasedAt,extensionUntil FROM RiskLegalHold ORDER BY id").all(),
    audit: db.prepare("SELECT id,action,details FROM AuditLog ORDER BY id").all(),
    events: db.prepare("SELECT id,action,scopeId FROM RiskControlEvent ORDER BY id").all(),
  });
  db.close();
  return {
    counts,
    logicalHash: sha256(dump),
    fileHash: sha256(fs.readFileSync(file)),
  };
}

function sameState(a, b) {
  return a.logicalHash === b.logicalHash && JSON.stringify(a.counts) === JSON.stringify(b.counts);
}

function runPreview(url) {
  const out = execFileSync(process.execPath, [CRON, "--dry-run"], {
    cwd: REPO_ROOT,
    env: { ...process.env, RETENTION_PREVIEW_DATABASE_URL: url },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.split(/\r?\n/).find((l) => l.includes("[risk-retention-preview] ok "));
  if (!line) throw new Error("preview produced no result line");
  return JSON.parse(line.slice(line.indexOf("{")));
}

function runSweep(mode, url) {
  const out = execFileSync(process.execPath, [TSX_CLI, SWEEP_HELPER, mode], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: url,
      RISK_RETENTION_TOKEN: SYNTHETIC_TOKEN,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.split(/\r?\n/).find((l) => l.includes(`[local-sweep] ${mode} `));
  if (!line) throw new Error(`sweep mode ${mode} produced no result line`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

function addMonthsMs(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target.getTime();
}

const iso = (ms) => new Date(ms).toISOString();

function seedMain(db, T) {
  const tenants = db.prepare(
    "INSERT INTO BusinessTenant (id,code,name,createdAt,updatedAt) VALUES (?,?,?,?,?)"
  );
  tenants.run("tenant-a", "RT-A", "Synthetic Tenant A", iso(T - 400 * DAY), iso(T - 400 * DAY));
  tenants.run("tenant-b", "RT-B", "Synthetic Tenant B", iso(T - 400 * DAY), iso(T - 400 * DAY));

  const insertSignal = db.prepare(`
    INSERT INTO AgentRiskSignal
      (id,tenantId,subjectKey,keyBasis,saltVersion,category,severity,status,
       sourceType,sourceId,internalNote,observedFrom,observedTo,expiresAt,
       withdrawnAt,frozenAt,disputedAt,resolvedAt,deletedAt,scrubbedAt,createdAt)
    VALUES
      (@id,@tenantId,@subjectKey,@keyBasis,@saltVersion,@category,@severity,@status,
       @sourceType,@sourceId,@internalNote,@observedFrom,@observedTo,@expiresAt,
       @withdrawnAt,@frozenAt,@disputedAt,@resolvedAt,@deletedAt,@scrubbedAt,@createdAt)
  `);

  function signal(id, opts = {}) {
    insertSignal.run({
      id,
      tenantId: opts.tenantId ?? null,
      subjectKey: opts.subjectKey ?? `subj-${id}`,
      keyBasis: "tenant-id",
      saltVersion: 1,
      category: "shortage",
      severity: "high",
      status: opts.status ?? "expired",
      sourceType: opts.sourceType ?? `daily_account-${id}`,
      sourceId: `src-${id}`,
      internalNote: opts.internalNote ?? null,
      observedFrom: iso(T - 200 * DAY),
      observedTo: iso(T - 181 * DAY),
      expiresAt: opts.expiresAt,
      withdrawnAt: opts.withdrawnAt ?? null,
      frozenAt: null,
      disputedAt: opts.disputedAt ?? null,
      resolvedAt: opts.resolvedAt ?? null,
      deletedAt: opts.deletedAt ?? null,
      scrubbedAt: null,
      createdAt: iso(T - 365 * DAY),
    });
  }

  // Older-than-threshold scrub candidate.
  signal("sig-expired-old", { tenantId: "tenant-a", expiresAt: iso(T - (180 + 90 + 30) * DAY) });
  // Near-exact 90-day boundary: deadline ~60s in the past.
  signal("sig-expired-boundary", { tenantId: "tenant-a", expiresAt: iso(T - 90 * DAY - 60_000) });
  // Just newer than the 90-day threshold: not a candidate.
  signal("sig-expired-new", { tenantId: "tenant-a", expiresAt: iso(T - 90 * DAY + 60_000) });
  // Open signal past its expiry: expiry candidate, not scrub candidate.
  signal("sig-open-due", { tenantId: "tenant-a", status: "open", expiresAt: iso(T - DAY) });
  signal("sig-open-future", { tenantId: "tenant-a", status: "open", expiresAt: iso(T + DAY) });
  // Withdrawal clock, both sides of the boundary.
  signal("sig-withdrawn-old", {
    tenantId: "tenant-b",
    status: "withdrawn",
    expiresAt: iso(T + 100 * DAY),
    withdrawnAt: iso(T - 91 * DAY),
  });
  signal("sig-withdrawn-new", {
    tenantId: "tenant-b",
    status: "withdrawn",
    expiresAt: iso(T + 100 * DAY),
    withdrawnAt: iso(T - 89 * DAY),
  });
  // Dispute resolution clock and unresolved dispute.
  signal("sig-disputed-resolved", {
    tenantId: "tenant-a",
    status: "disputed_frozen",
    expiresAt: iso(T - 200 * DAY),
    resolvedAt: iso(T - 91 * DAY),
  });
  signal("sig-disputed-open", {
    tenantId: "tenant-a",
    status: "disputed_frozen",
    expiresAt: iso(T - 200 * DAY),
    resolvedAt: null,
  });
  // Legal hold variants.
  signal("sig-held", { tenantId: "tenant-a", expiresAt: iso(T - 300 * DAY) });
  signal("sig-held-extended", { tenantId: "tenant-b", expiresAt: iso(T - 300 * DAY) });
  signal("sig-released-hold", { tenantId: "tenant-b", expiresAt: iso(T - 300 * DAY) });
  signal("sig-subject-held", {
    tenantId: "tenant-b",
    subjectKey: "subject-under-hold",
    expiresAt: iso(T - 300 * DAY),
  });
  // Timezone offsets that resolve to different UTC instants.
  signal("sig-tz-plus", {
    tenantId: "tenant-a",
    expiresAt: iso(T - 100 * DAY + 14 * 3_600_000).replace("Z", "") + "+14:00",
  });
  signal("sig-tz-minus", {
    tenantId: "tenant-a",
    expiresAt: iso(T - 89 * DAY - 12 * 3_600_000).replace("Z", "") + "-12:00",
  });
  // Already deleted: never a candidate.
  signal("sig-deleted", {
    tenantId: "tenant-a",
    expiresAt: iso(T - 300 * DAY),
    deletedAt: iso(T - 10 * DAY),
  });
  // F1 regression: two rows, one tenant, one sourceType. Fixed scrub values
  // used to collide on the production unique constraint.
  signal("sig-f1-a", {
    tenantId: "tenant-a",
    sourceType: "shared-source-type",
    expiresAt: iso(T - 300 * DAY),
  });
  signal("sig-f1-b", {
    tenantId: "tenant-a",
    sourceType: "shared-source-type",
    expiresAt: iso(T - 300 * DAY),
  });

  // 500-row scrub batch test.
  for (let i = 0; i < 500; i += 1) {
    signal(`zz-sig-batch-${String(i).padStart(3, "0")}`, {
      tenantId: i % 2 === 0 ? "tenant-a" : "tenant-b",
      expiresAt: iso(T - 300 * DAY),
    });
  }

  const insertDisclosure = db.prepare(`
    INSERT INTO RiskIntelligenceDisclosure
      (id,tenantId,subjectKey,disclosed,contributorCount,viewerId,reason,createdAt,deletedAt)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insertDisclosure.run("disc-old", "tenant-a", "subj-disc-old", "counts", 2, "viewer-1", "preview", iso(addMonthsMs(T, -25)), null);
  insertDisclosure.run("disc-new", "tenant-b", "subj-disc-new", "counts", 3, "viewer-1", "preview", iso(addMonthsMs(T, -23)), null);
  insertDisclosure.run("disc-boundary", "tenant-a", "subj-disc-boundary", "counts", 2, "viewer-1", "preview", iso(addMonthsMs(T, -24) - 60_000), null);
  insertDisclosure.run("disc-deleted", "tenant-a", "subj-disc-deleted", "counts", 2, "viewer-1", "preview", iso(addMonthsMs(T, -30)), iso(T - DAY));
  for (let i = 0; i < 500; i += 1) {
    insertDisclosure.run(
      `zz-disc-batch-${String(i).padStart(3, "0")}`,
      i % 2 === 0 ? "tenant-a" : "tenant-b",
      `subj-disc-batch-${i}`,
      "counts",
      2,
      "viewer-1",
      "preview",
      iso(addMonthsMs(T, -25)),
      null
    );
  }

  const insertHold = db.prepare(`
    INSERT INTO RiskLegalHold
      (id,scopeType,scopeId,tenantId,dpoReference,reason,authorisedById,createdAt,reviewDate,
       caseClosureDate,extensionUntil,extensionReason,releasedAt,releasedById,releaseReason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insertHold.run("hold-signal", "signal", "sig-held", "tenant-a", "DP-1", "synthetic", "owner", iso(T - 40 * DAY), iso(T - 26 * DAY), null, null, null, null, null, null);
  insertHold.run("hold-extension", "signal", "sig-held-extended", "tenant-b", "DP-2", "synthetic", "owner", iso(T - 40 * DAY), iso(T - 26 * DAY), null, iso(T + 10 * DAY), "synthetic extension", null, null, null);
  insertHold.run("hold-released", "signal", "sig-released-hold", "tenant-b", "DP-3", "synthetic", "owner", iso(T - 40 * DAY), iso(T - 26 * DAY), null, null, null, iso(T - 20 * DAY), "owner", "released");
  insertHold.run("hold-subject", "subject", "subject-under-hold", "tenant-b", "DP-4", "synthetic", "owner", iso(T - 40 * DAY), iso(T - 26 * DAY), null, null, null, null, null, null);
  insertHold.run("hold-review-due", "request", "req-1", "tenant-a", "DP-5", "synthetic", "owner", iso(T - 30 * DAY), iso(T - 16 * DAY), iso(T - 15 * DAY), null, null, null, null, null);
  insertHold.run("hold-review-fresh", "request", "req-2", "tenant-b", "DP-6", "synthetic", "owner", iso(T - 5 * DAY), iso(T + 9 * DAY), iso(T - DAY), null, null, null, null, null);
}

function seedExact(db, T) {
  const insertSignal = db.prepare(`
    INSERT INTO AgentRiskSignal
      (id,tenantId,subjectKey,keyBasis,saltVersion,category,severity,status,sourceType,sourceId,
       observedFrom,observedTo,expiresAt,createdAt)
    VALUES (@id,@tenantId,@subjectKey,@keyBasis,@saltVersion,@category,@severity,@status,
            @sourceType,@sourceId,@observedFrom,@observedTo,@expiresAt,@createdAt)
  `);
  function smallSignal(id, status, expiresAt, tenantId) {
    insertSignal.run({
      id,
      tenantId,
      subjectKey: `exact-subj-${id}`,
      keyBasis: "tenant-id",
      saltVersion: 1,
      category: "shortage",
      severity: "high",
      status,
      sourceType: `exact-source-${id}`,
      sourceId: `exact-src-${id}`,
      observedFrom: iso(T - 300 * DAY),
      observedTo: iso(T - 281 * DAY),
      expiresAt,
      createdAt: iso(T - 365 * DAY),
    });
  }
  smallSignal("exact-expired-1", "expired", iso(T - 300 * DAY), null);
  smallSignal("exact-expired-2", "expired", iso(T - 300 * DAY), null);
  smallSignal("exact-open", "open", iso(T - DAY), null);
  smallSignal("exact-held", "expired", iso(T - 300 * DAY), null);
  db.prepare(`
    INSERT INTO RiskLegalHold
      (id,scopeType,scopeId,tenantId,dpoReference,reason,authorisedById,createdAt,reviewDate)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run("exact-hold", "signal", "exact-held", null, "DP-EX", "synthetic", "owner", iso(T - 40 * DAY), iso(T - 26 * DAY));
  const insertDisclosure = db.prepare(`
    INSERT INTO RiskIntelligenceDisclosure
      (id,tenantId,subjectKey,disclosed,contributorCount,viewerId,reason,createdAt,deletedAt)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insertDisclosure.run("exact-disc-1", null, "exact-subj-1", "counts", 1, "viewer", "preview", iso(addMonthsMs(T, -25)), null);
  insertDisclosure.run("exact-disc-2", null, "exact-subj-2", "counts", 1, "viewer", "preview", iso(addMonthsMs(T, -30)), null);
}

function seedConcurrency(db, T) {
  const insertSignal = db.prepare(`
    INSERT INTO AgentRiskSignal
      (id,tenantId,subjectKey,keyBasis,saltVersion,category,severity,status,
       sourceType,sourceId,internalNote,observedFrom,observedTo,expiresAt,
       withdrawnAt,frozenAt,disputedAt,resolvedAt,deletedAt,scrubbedAt,createdAt)
    VALUES
      (@id,@tenantId,@subjectKey,@keyBasis,@saltVersion,@category,@severity,@status,
       @sourceType,@sourceId,@internalNote,@observedFrom,@observedTo,@expiresAt,
       @withdrawnAt,@frozenAt,@disputedAt,@resolvedAt,@deletedAt,@scrubbedAt,@createdAt)
  `);
  for (let i = 0; i < 5; i += 1) {
    insertSignal.run({
      id: `conc-sig-${i}`,
      tenantId: null,
      subjectKey: `conc-subj-${i}`,
      keyBasis: "tenant-id",
      saltVersion: 1,
      category: "shortage",
      severity: "high",
      status: "expired",
      sourceType: `daily_account-conc-${i}`,
      sourceId: `conc-src-${i}`,
      internalNote: null,
      observedFrom: iso(T - 300 * DAY),
      observedTo: iso(T - 281 * DAY),
      expiresAt: iso(T - 300 * DAY),
      withdrawnAt: null,
      frozenAt: null,
      disputedAt: null,
      resolvedAt: null,
      deletedAt: null,
      scrubbedAt: null,
      createdAt: iso(T - 365 * DAY),
    });
  }
  const insertDisclosure = db.prepare(`
    INSERT INTO RiskIntelligenceDisclosure
      (id,tenantId,subjectKey,disclosed,contributorCount,viewerId,reason,createdAt,deletedAt)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insertDisclosure.run("conc-disc", null, "conc-subj", "counts", 1, "viewer", "preview", iso(T - 30 * DAY), null);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("Local retention verification (disposable SQLite, synthetic data only)");
ensureSqliteClient();

execFileSync(process.execPath, [TSX_CLI, ARITHMETIC], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: process.env,
});
check("date arithmetic: constants, 90/180-day, 24-month clamp, timezone, holds", true);

const T = Date.now();
const main = makeDb("main");
const secondary = makeDb("secondary");
const exact = makeDb("exact");

// Empty data set: zero candidates.
const emptyPreview = runPreview(secondary.url);
check(
  "preview on empty database returns all zero counts",
  emptyPreview.expiredCandidates === 0 &&
    emptyPreview.scrubCandidates === 0 &&
    emptyPreview.auditCandidates === 0 &&
    emptyPreview.holdsSkipped === 0 &&
    emptyPreview.legalHoldReviewCandidates === 0,
  emptyPreview
);
results.emptyPreview = emptyPreview;

// Seed the main scenario in one transaction.
{
  const db = openWrite(main.file);
  db.transaction(() => seedMain(db, T))();
  db.close();
}

const before = snapshot(main.file);
const preview1 = runPreview(main.url);
const afterPreview1 = snapshot(main.file);

check(
  "dry-run causes zero database mutations (logical state and counts unchanged)",
  sameState(before, afterPreview1),
  { before: before.counts, after: afterPreview1.counts }
);
check(
  "dry-run leaves the database file byte-identical",
  before.fileHash === afterPreview1.fileHash,
  { before: before.fileHash.slice(0, 16), after: afterPreview1.fileHash.slice(0, 16) }
);

const preview2 = runPreview(main.url);
const countProjection = (p) => ({
  expiredCandidates: p.expiredCandidates,
  scrubCandidates: p.scrubCandidates,
  auditCandidates: p.auditCandidates,
  holdsSkipped: p.holdsSkipped,
  legalHoldReviewCandidates: p.legalHoldReviewCandidates,
  scrubBatchLimited: p.scrubBatchLimited,
  auditBatchLimited: p.auditBatchLimited,
});
check(
  "repeated dry-run returns identical aggregate counts",
  JSON.stringify(countProjection(preview1)) === JSON.stringify(countProjection(preview2)),
  { first: preview1, second: preview2 }
);
check(
  "dry-run reports expired, scrub, audit, hold and batch counts",
  preview1.expiredCandidates === 1 &&
    preview1.holdsSkipped === 3 &&
    preview1.legalHoldReviewCandidates === 1 &&
    preview1.scrubBatchLimited === true &&
    preview1.auditBatchLimited === true &&
    preview1.scrubCandidates > 0 &&
    preview1.auditCandidates > 0,
  preview1
);
results.preview1 = preview1;

// Wrong token: authorisation failure must not mutate anything.
const forbidden = runSweep("forbidden", main.url);
const afterForbidden = snapshot(main.file);
check(
  "wrong token is rejected with no mutation",
  forbidden.success === false && sameState(before, afterForbidden),
  { forbidden }
);
results.forbidden = forbidden;

// Real local execution against the same disposable database.
const sweep1 = runSweep("system", main.url);
check(
  "real local sweep counts exactly match the preview at the ordered 500-row edge",
  sweep1.success === true &&
    sweep1.data?.expired === preview1.expiredCandidates &&
    sweep1.data?.scrubbed === preview1.scrubCandidates &&
    sweep1.data?.audited === preview1.auditCandidates,
  { preview: preview1, sweep: sweep1 }
);
{
  const probe = new Database(main.file, { readonly: true, fileMustExist: true });
  const f1 = probe
    .prepare("SELECT id,subjectKey,sourceId,deletedAt FROM AgentRiskSignal WHERE id IN ('sig-f1-a','sig-f1-b') ORDER BY id")
    .all();
  probe.close();
  check(
    "F1: same-tenant same-sourceType rows scrub with unique non-identifying keys",
    f1.length === 2 &&
      f1[0].subjectKey === "scrubbed:sig-f1-a" &&
      f1[1].subjectKey === "scrubbed:sig-f1-b" &&
      f1[0].sourceId !== f1[1].sourceId &&
      f1.every((r) => r.deletedAt !== null),
    f1
  );
}
results.sweep1 = sweep1;

const afterSweep1 = snapshot(main.file);
check(
  "real local sweep mutates rows and writes an audit record",
  afterSweep1.counts.auditLogs > before.counts.auditLogs &&
    afterSweep1.counts.controlEvents > before.counts.controlEvents &&
    afterSweep1.logicalHash !== before.logicalHash,
  { before: before.counts, after: afterSweep1.counts }
);

// Remaining candidates after the 500-row partial batch.
const previewAfter1 = runPreview(main.url);
check(
  "preview after partial batch shows only remaining candidates",
  previewAfter1.expiredCandidates === 0 &&
    previewAfter1.scrubCandidates > 0 &&
    previewAfter1.auditCandidates > 0,
  previewAfter1
);
results.previewAfter1 = previewAfter1;

// Second sweep recovers the remainder left by the batch limit.
const sweep2 = runSweep("system", main.url);
check(
  "second sweep completes the remaining 500-row batches",
  sweep2.success === true &&
    sweep2.data?.scrubbed === previewAfter1.scrubCandidates &&
    sweep2.data?.audited === previewAfter1.auditCandidates,
  { preview: previewAfter1, sweep: sweep2 }
);
results.sweep2 = sweep2;

const previewAfter2 = runPreview(main.url);
check(
  "preview after recovery reports no remaining candidates",
  previewAfter2.scrubCandidates === 0 &&
    previewAfter2.auditCandidates === 0 &&
    previewAfter2.expiredCandidates === 0,
  previewAfter2
);
results.previewAfter2 = previewAfter2;

// Duplicate execution: no new mutations and no extra audit row.
const stateBeforeDuplicate = snapshot(main.file);
const sweep3 = runSweep("system", main.url);
const stateAfterDuplicate = snapshot(main.file);
check(
  "duplicate execution performs no second scrub or de-identification",
  sweep3.data?.expired === 0 &&
    sweep3.data?.scrubbed === 0 &&
    sweep3.data?.audited === 0 &&
    stateBeforeDuplicate.counts.signals === stateAfterDuplicate.counts.signals &&
    stateBeforeDuplicate.counts.disclosures === stateAfterDuplicate.counts.disclosures &&
    stateBeforeDuplicate.counts.auditLogs === stateAfterDuplicate.counts.auditLogs,
  { sweep: sweep3, before: stateBeforeDuplicate.counts, after: stateAfterDuplicate.counts }
);
check(
  "F4: duplicate execution does not repeat legal-hold review control events",
  stateAfterDuplicate.counts.controlEvents === stateBeforeDuplicate.counts.controlEvents,
  { before: stateBeforeDuplicate.counts.controlEvents, after: stateAfterDuplicate.counts.controlEvents }
);
results.sweep3 = sweep3;

// expireStaleRiskSignals alone: token-gated, no deletion.
{
  const db = openWrite(main.file);
  db.prepare(
    `INSERT INTO AgentRiskSignal
      (id,tenantId,subjectKey,keyBasis,saltVersion,category,severity,status,sourceType,sourceId,
       observedFrom,observedTo,expiresAt,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    "sig-expire-only",
    null,
    "subj-expire-only",
    "tenant-id",
    1,
    "shortage",
    "high",
    "open",
    "daily_account",
    "src-expire-only",
    iso(T - 200 * DAY),
    iso(T - 181 * DAY),
    iso(T - DAY),
    iso(T - 365 * DAY)
  );
  db.close();
}
const beforeExpire = runPreview(main.url);
const expireResult = runSweep("expire", main.url);
const afterExpire = runPreview(main.url);
check(
  "expireStaleRiskSignals expires due signals without deleting them",
  expireResult.success === true &&
    expireResult.expired >= 1 &&
    beforeExpire.expiredCandidates === 1 &&
    afterExpire.expiredCandidates === 0,
  { beforeExpire: beforeExpire.expiredCandidates, expireResult, afterExpire: afterExpire.expiredCandidates }
);
results.expireResult = expireResult;

// Exact preview-to-execution parity without a batch boundary.
{
  const db = openWrite(exact.file);
  db.transaction(() => seedExact(db, T))();
  db.close();
  const exactPreview = runPreview(exact.url);
  const exactSweep = runSweep("system", exact.url);
  check(
    "preview counts exactly equal real sweep counts when no batch limit is hit",
    exactSweep.success === true &&
      exactPreview.expiredCandidates === 1 &&
      exactPreview.scrubCandidates === 2 &&
      exactPreview.auditCandidates === 2 &&
      exactPreview.holdsSkipped === 1 &&
      exactPreview.scrubBatchLimited === false &&
      exactPreview.auditBatchLimited === false &&
      exactSweep.data?.expired === exactPreview.expiredCandidates &&
      exactSweep.data?.scrubbed === exactPreview.scrubCandidates &&
      exactSweep.data?.audited === exactPreview.auditCandidates,
    { preview: exactPreview, sweep: exactSweep }
  );
  results.exact = { preview: exactPreview, sweep: exactSweep };
  const exactAfter = runPreview(exact.url);
  check(
    "held row survives exact sweep while eligible rows are gone",
    exactAfter.scrubCandidates === 0 &&
      exactAfter.auditCandidates === 0 &&
      exactAfter.expiredCandidates === 0 &&
      snapshot(exact.file).counts.signals === 4,
    exactAfter
  );
  const exactDuplicate = runSweep("system", exact.url);
  check(
    "duplicate execution on exact database is a no-op",
    exactDuplicate.data?.expired === 0 &&
      exactDuplicate.data?.scrubbed === 0 &&
      exactDuplicate.data?.audited === 0,
    exactDuplicate
  );
  results.exactDuplicate = exactDuplicate;
}

// Concurrent attempts on a fresh isolated database.
{
  const db = openWrite(secondary.file);
  db.transaction(() => seedConcurrency(db, T))();
  db.close();
}
const concurrentPreviewBefore = runPreview(secondary.url);
const concurrentResult = runSweep("concurrent", secondary.url);
const concurrentPreviewAfter = runPreview(secondary.url);
check(
  "concurrent attempts leave zero candidates in the final database state",
  Array.isArray(concurrentResult.results) &&
    concurrentPreviewBefore.scrubCandidates === 5 &&
    concurrentPreviewAfter.scrubCandidates === 0 &&
    concurrentPreviewAfter.auditCandidates === 0,
  { before: concurrentPreviewBefore, result: concurrentResult, after: concurrentPreviewAfter }
);
check(
  "finding: action-level concurrent calls both report scrubs (route overlap guard is route-only)",
  concurrentResult.results.every((r) => r.success === true && r.data?.scrubbed === 5),
  concurrentResult
);
results.concurrent = { before: concurrentPreviewBefore, result: concurrentResult, after: concurrentPreviewAfter };

// Evidence file. Contains counts only: no URLs, tokens or row values.
fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
fs.writeFileSync(
  EVIDENCE,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      environment: "disposable SQLite under OS temp directory; synthetic data only",
      productionAccess: "none",
      checks,
      results,
    },
    null,
    2
  )
);

console.log(`All ${checks.length} checks passed. Evidence: tests/local-retention-evidence.json`);
