# PostgreSQL migration review — risk intelligence

Reviewer: engineering. Date: 2026-11-25. Scope: static review of
`prisma/migrations/20261221_shared_risk_intelligence`, 
`20261222_risk_intelligence_governance_safeguards`,
`20261223_risk_intelligence_legal_execution` and
`20261224_risk_organisation_profile` against `prisma/schema-pg.prisma`.
No PostgreSQL database was contacted. No migration was applied.

## 1. Result

PASS — static review. The scripts are additive and ordered after the existing
history. No table, column, index or row is dropped, renamed, truncated or
rewritten. The only caveat is that execution against the target database remains
an infrastructure action requiring a backup and a change window.

## 2. Ordering and dependencies

1. `20261221` creates `RiskIntelligenceConsent`, `AgentRiskSignal` and
   `RiskIntelligenceDisclosure`, their indexes and tenant foreign keys.
2. `20261222` adds governance columns to those tables and creates
   `RiskGlobalControl`, `RiskSubjectFreeze`, `SubjectRightsRequest`,
   `RightsRequestCommunication`, `EmployeePrivacyNotice`,
   `EmployeeNoticeAttestation`, `ParticipationAgreement`, `RiskLegalHold`,
   `RiskControlEvent`, `RiskKeyVersion`, `RiskPrivacyAccess` and
   `GovernanceDocumentDelivery`.
3. `20261223` adds the legal-execution columns and two indexes.
4. `20261224` creates the additive single-row `RiskOrganisationProfile` for
   verified organisation facts. It has no tenant foreign key and does not
   rewrite existing rows.

The folder names sort lexicographically in the intended order. The history
`migration_lock.toml` is PostgreSQL; SQLite uses the separate parity script
described in section 5.

## 3. SQL portability and correctness

- PostgreSQL accepts multi-column `ALTER TABLE ... ADD COLUMN` statements used
  in `20261222` and `20261223`.
- `BOOLEAN NOT NULL DEFAULT false`, `TIMESTAMP(3)` and `TEXT` map cleanly to the
  PostgreSQL schema.
- New indexes are non-unique except the intended uniqueness constraints
  (consent tenant/policy, signal tenant/subject/source, notice version,
  agreement tenant/type/version, rights case reference, privacy access user and
  delivery event/scope/recipient hash).
- Nullable `tenantId` on consent is intentional for a global/query-only record;
  PostgreSQL permits multiple nulls under the unique index.
- Foreign keys point only to existing parent tables; cascade rules match the
  schema.
- No `DROP`, `TRUNCATE`, `DELETE`, `UPDATE` or column rewrite appears.

## 4. Pre-application checks

1. Take a verified backup and record the restore point.
2. Run `npx prisma validate --schema=prisma/schema-pg.prisma`.
3. Run `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema-pg.prisma --script` against a staging clone and confirm the only changes are the risk tables, columns and indexes.
4. Apply in a transaction if the provider supports transactional DDL; otherwise apply each file and verify.
5. Confirm the application generated client targets PostgreSQL before deployment.
6. Re-run the readiness check and the focused risk tests against staging; do not point tests at production.

## 5. SQLite parity (local only)

The repository's SQLite database does not use the PostgreSQL migration folder.
`scripts/apply-risk-sqlite.ts` applies the same additive tables, columns and
indexes one column at a time, idempotently, to the existing SQLite database. It
uses `CREATE TABLE IF NOT EXISTS` and `PRAGMA table_info`; it never drops or
truncates. This is a development/verification parity helper, not a production
migration and not a substitute for the reviewed PostgreSQL files.

## 6. Remaining risk

- A production database that is already ahead of the migration history must be
  baselined by the infrastructure owner, not repaired by editing applied SQL.
- Long-running index creation on a large table should use the provider's
  concurrent-index option if available.
- The application must not start serving risk traffic until the columns exist;
  the readiness check fails closed on missing tables.
