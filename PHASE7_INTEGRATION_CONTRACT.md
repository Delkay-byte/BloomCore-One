# Phase 7 Integration Contract — Customer Onboarding, Bulk Import and Data Migration

This document is the boundary record for Phase 7. It states what Phase 7 owns, the
exact schema and server-action surface it adds, the invariants it guarantees, and what
later phases may and may not assume. It does not restate the branch model of Phase 1 or
the collector model of Phase 2 — Phase 7 integrates with both at the documented boundary.

## Verified baseline

- Common baseline commit: `7073548` on `feat/susu-enterprise-phases-1-3-integration`.
- Phase 7 branch: `feat/susu-enterprise-phase-7-customer-onboarding`.
- Phase 7 worktree: `C:\Users\SAVIOUR\Documents\DScience\BIK Prestige Ent\BloomCore-One-phase-7`.
- No push, no pull request, no merge, no deploy, no production or hosted database access.
- Other agent worktrees (Phases 4, 5, 6) were neither read for implementation nor modified.

---

## 1. Scope of this phase

Phase 7 makes a real business able to move its existing Susu book into MaaCash without
inventing history.

In scope:

1. Individual customer registration in the office.
2. Individual customer registration in the field by a collector.
3. One customer, many accounts — an explicit identity split that every later phase inherits.
4. Account-level branch attribution, reusing Phase 1's `Location` and `BranchMembership`.
5. CSV bulk import as a staged, reviewed pipeline with a safe commit.
6. Import history, row-level error reports and a resumable, idempotent commit.
7. Tenant, branch and collector authorisation on every path, reusing Phase 1 helpers.

Out of scope, deliberately:

- Back-filling `Contribution`, `Withdrawal`, `Commission` or `CardFee` rows for past
  months. A migration moves identity, never money.
- Spreadsheet (`.xlsx`) parsing. CSV only; no new dependency.
- Merging two existing customer records (a manual, audited de-duplication tool is a later
  phase concern).
- Any bulk operation that runs without a human confirming a specific plan.

---

## 2. Data model changes

All changes are additive; both `prisma/schema.prisma` (SQLite) and `prisma/schema-pg.prisma`
(PostgreSQL) were changed identically, differing only in `provider` and two mapped indexes.

### 2.1 `Customer` — the person

| Column | Type | Meaning |
| --- | --- | --- |
| `externalReference` | `String?` | The business's own reference. **Not unique** — the same passbook number may legitimately repeat across years. Indexed with `tenantId`. |
| `registeredVia` | `String?` | `office` \| `field` \| `import` \| `legacy`. Provenance of the record, not of the person. |
| `registeredById` | `String?` | The user who registered them. Never rewritten. |
| `registeredBranchId` | `String?` | The branch that took the registration. |
| `notes` | `String?` | Free text the office wants kept. |

`Customer.email` keeps its **global** `@unique` constraint. That is the final arbiter of an
e-mail collision (Prisma `P2002`); import pre-checks it so the operator sees a clear row
error rather than a failed transaction.

### 2.2 `SusuAccount` — the account

| Column | Type | Meaning |
| --- | --- | --- |
| `branchId` | `String?` | The branch that owns collection on this account. `NULL` means unassigned, never guessed. |
| `openingDate` | `DateTime?` | The real date the savings started. `NULL` means unknown, which is honest and allowed. |
| `openedVia` | `String?` | `office` \| `field` \| `import` \| `legacy`. |
| `openedById` | `String?` | Actor at creation time. |
| `externalAccountReference` | `String?` | The number in the business's own book, when MaaCash issued a different `accountId`. |
| `importBatchId` | `String?` | Provenance: which import created this account. |

### 2.3 `CustomerImportBatch` — one staged migration

Cuid id, optional `tenantId`/`branchId`, `branchMode` (`single_branch` \| `row_column`),
`sourceFormat` (`csv`), `fileName`, `fileHash`, `fileSizeBytes`, `sourceText`,
`headerHash`, `headers` (JSON), `columnMapping` (JSON), `status`,
thirteen counters, `planHash`, `initiatedById`, `validatedAt`, `confirmedAt`,
`confirmedById`, `commitToken`, `commitStartedAt`, `commitLeaseUntil`, `committedAt`,
`committedById`, `failureReason`.

- `@@unique([tenantId, fileHash])` is what makes re-uploading the same file **resume** the
  same batch instead of creating a second one.
- `sourceText` holds the raw file (4 MB cap) so a batch can be re-validated deterministically
  after the operator changes the column mapping. It is cleared when the batch reaches
  `committed` or `cancelled`, so finished imports do not retain the raw register.

### 2.4 `CustomerImportRow` — one line of the file

`rowNumber`, `rawRow`, parsed `customerName`/`phone`/`phoneNormalized`/`email`/
`externalReference`/`address`/`notes`/`accountNumber`/`dailyContribution`/
`openingDate`/`branchRef`/`collectorRef`, `classification`, `issues` (JSON),
`matchReasons` (JSON), `matchedCustomerId`, `matchedAccountId`, `branchId`, `collectorId`,
`resolution`, `resolvedById`, `resolvedAt`, `resolutionNote`, `outcome`,
`outcomeMessage`, `createdCustomerId`, `createdAccountId`, `committedAt`.

- `@@unique([batchId, rowNumber])` makes the commit idempotent per row.

### 2.5 `CustomerImportRowEvent` — append-only decision history

`batchId`, `rowId`, `kind`, `actorId`, `fromResolution`, `toResolution`, `note`.
Nothing updates or deletes these rows; `onDelete: Cascade` from the batch is the only way
they leave the table, and only while an import has created nothing.

### 2.6 Migration

`prisma/migrations/20261229_susu_customer_onboarding/migration.sql` — additive PG SQL only:
new columns, new tables, new indexes, new foreign keys. No `DROP`, no `RENAME`, no
`TRUNCATE`, no data backfill. It applies cleanly to an existing Phase 1–3 database and was
verified against a disposable PostgreSQL 16 container
(`_prisma_migrations` shows `20261229_susu_customer_onboarding` finished).

---

## 3. Customer identity versus account identity

This is the invariant later phases must respect.

1. **One `Customer` row per person per business.** `Customer` carries no branch; a person
   who saves in two branches is one customer with two accounts.
2. **A phone number is contact information, not identity.** Shared family phones and missing
   phones are allowed. MaaCash never merges or splits people on a phone number alone.
3. **`SusuAccount.branchId` is the branch of record.** A customer's branch is derived from
   their accounts, never stored on the person.
4. **`externalReference` is not a key.** Two people may share a passbook number across
   years; the import reports the coincidence instead of merging them.
5. **E-mail is the only globally unique customer attribute**, inherited from the existing
   schema. A collision is surfaced as a row error naming the rule, never as a stack trace.

---

## 4. Onboarding channels

`src/lib/susu/onboarding.ts` is the single write path for a new customer and a new account.
It exposes:

- `onboardCustomerWithAccount(tx, input)` — creates the person and one account with its
  first cycle, inside the caller's transaction.
- `openAdditionalAccount(tx, input)` — adds an account to an existing person.
- `insertCustomer` / `insertAccountWithCycle` — the composable pieces.
- `allocateHumanIds(tx, "customer" | "account", count)` — issues `BIK-C-######` /
  `BIK-S-######` ids by probing in batches and failing loudly rather than returning a
  duplicate.
- `reusableAccountNumber(value)` — refuses to reuse a MaaCash-shaped number for an imported
  account, so an outside book can never squat on the internal id space.
- `phoneKey`, `personNameKey`, `referenceKey`, `emailKey`, `cleanText`, `parseMoneyCell`,
  `moneyString` — the shared normalisation rules. The import and the forms use the same ones.

Every created account gets **cycle 1 starting in the current month**, with
`commissionCharged: false`. An account with no active cycle cannot accept a contribution, so
an account without one would be a dead record; a historical `openingDate` is preserved on
the account for audit and is *not* used to fabricate past cycles.

Channels:

| Channel | Entry point | Actor |
| --- | --- | --- |
| `office` | `registerCustomerOnboarding` (`src/lib/actions/susu-onboarding.actions.ts`), `createCustomer` (existing customers page) | Tenant admin, branch-scoped admin |
| `field` | `registerCustomerByCollector` (`src/lib/actions/susu-collector.actions.ts`) | Active collector |
| `import` | `commitImportBatch` | Tenant admin only |
| `legacy` | reserved for a future read-only migration tool; not written by this phase | — |

`createCustomer` and `registerCustomerByCollector` were refactored onto
`onboardCustomerWithAccount`; their previous id allocation helpers were deleted. Their
public response shapes, error strings and id formats are unchanged, so the existing
customers and collector screens keep working.

---

## 5. Bulk import lifecycle

```
upload -> inspect -> map columns -> validate -> duplicate detection
       -> resolve -> preview -> confirm (typed word + plan digest) -> commit -> report
```

`CustomerImportBatch.status` moves only along:

```
staged -> validated -> ready -> committing -> committed
                                   |-> partially_committed
                                   |-> failed   (retryable)
staged|validated|ready -> cancelled
```

| Stage | Action | What it guarantees |
| --- | --- | --- |
| Upload / inspect | `createImportBatch(formData)` | File is CSV, non-empty, under 4 MB, ≤ 5,000 rows and ≤ 40 columns; headers hashed; same `fileHash` resumes the same batch; audit `susu.customer_import_batch_created`. |
| Map columns | `getImportFieldCatalogue`, `autoDetectMapping`, `validateMapping` | A column may be mapped once; `fullName` and `dailyContribution` are mandatory; mapping is persisted as JSON. |
| Validate | `validateImportBatch({batchId, mapping})` | Re-parses `sourceText`, classifies every row against live tenant data, writes rows + `issues` + `matchReasons`, recomputes counters, sets `ready` only when no row still needs a decision; audit `susu.customer_import_validated`. |
| Resolve | `resolveImportRows({batchId, resolutions})` | Only resolutions legal for that classification are accepted; a mandatory note for overrides; append-only `CustomerImportRowEvent`; audit `susu.customer_import_rows_resolved`. |
| Preview | `getImportPreview({batchId, filter, limit})` | Returns the exact `planHash` the operator will confirm, the counters and the filtered rows. |
| Confirm | `confirmImportBatch({batchId, planHash, confirmText})` | Requires the literal word `IMPORT` **and** the digest of the plan on screen. |
| Commit | `commitImportBatch` | See section 7. |
| Report | `getImportErrorReport({batchId})` | CSV of the rows that cannot be imported, still need a decision, or failed. A clean finished import reports zero rows. |
| History | `getImportBatches()` | Tenant-scoped list with counters and status. |
| Discard | `discardImportBatch({batchId})` | Only while nothing was created; deletes rows/events and clears `sourceText`. Refused once a customer exists, because the batch is their provenance. |

Limits (`CSV_LIMITS`, `ONBOARDING_LIMITS`): 4 MB / 5,000 rows / 40 columns / 500 chars per
cell; name 2–120, phone ≤ 32, address ≤ 240, notes ≤ 500, reference ≤ 64, daily
contribution 0.01–100,000, card fee 0–10,000.

---

## 6. Duplicate detection and classification

Each row gets exactly one classification and, where safe, a proposed resolution.

| Classification | Meaning | Proposed resolution | Blocks commit |
| --- | --- | --- | --- |
| `new_customer` | No existing person matches on a strong key. | `create_new` | no |
| `new_account_existing_customer` | Matches exactly one person on a **strong** key (phone, e-mail, reference, or account number). | `link_existing` | no |
| `exact_duplicate` | The account number, or the same person with the same name and contact details, is already known. | `exclude` | no |
| `possible_customer_duplicate` | A name-only match, a contact shared by different names, or several candidates. | none | **yes** |
| `account_conflict` | The account number exists and belongs to a different name. | none | **yes** |
| `customer_conflict` | The e-mail is registered to a customer of another business. | none | **yes** |
| `invalid` | A field cannot be used (missing name or amount, impossible date, unauthorised branch). | none | no — reported as skipped |

Rules that are enforced in code, not by convention:

- A **name-only** match is never auto-linked; it always asks.
- Two rows in one file sharing a phone or e-mail **under different names** produce
  `possible_customer_duplicate` even when the second row would otherwise look new. A shared
  family phone must never silently collapse two people.
- Two identical rows in one file (same name, same contact) are an `exact_duplicate`.
- An account number that appears twice inside one file is an `invalid` row, not a duplicate.
- `invalid` rows never block a commit; they are reported as `skipped` with the reason.

---

## 7. Commit contract

`computePlanHash({branchMode, branchId, mapping, rows})` is a SHA-256 digest over a canonical
string (`maa-cash-customer-import-v1`) of the decision set: every row's resolution, matched
customer and target branch. It is **stable** for an unchanged plan and changes whenever
anything the operator approved changes.

`commitImportBatch({tenantId, batchId, actorId, planHash, allowedBranchIds, allowUnassignedBranch})`
guarantees:

1. **Idempotency.** A batch already `committed` returns success with
   `alreadyCommitted: true` and writes nothing. Rows already carrying an outcome are skipped.
2. **Plan integrity.** If `planHash` no longer matches, the commit is refused with
   *"The plan changed since you reviewed it. Re-open the preview and confirm again."*
3. **Readiness.** Any row still needing a decision blocks the commit with a count.
4. **Single writer.** A conditional `updateMany` claims a lease (`commitToken`,
   `commitLeaseUntil`, 180 s) on `status IN (ready, validated, partially_committed, failed)`
   and an expired-or-own lease. A second concurrent commit cannot proceed.
5. **Chunked transactions** of 25 rows. A retryable write conflict is retried twice; a
   persistent failure fails that row only, is recorded with a readable message, and the
   batch ends `partially_committed` (some rows written) or `failed` (none). No silent
   renumbering, no half-written person without an account.
6. **Counters recomputed from rows** after every chunk, so the batch totals can never drift
   from the row table.
7. **Audit** `susu.customer_import_committed` at batch level, plus
   `susu.customer_import_customer_created` and `susu.customer_import_account_linked` per row.

Account numbers: an imported number is reused as `accountId` only when
`reusableAccountNumber()` accepts it **and** it is globally free; otherwise MaaCash allocates
`BIK-S-######` and keeps the original in `externalAccountReference`. If the number was claimed
between validation and commit, the row fails with an explicit message.

---

## 8. Authorisation, tenant and branch scoping

- The tenant comes only from the verified session (`getTenantContext("admin", "susu")`); no
  tenant id is ever read from the request body.
- Bulk import and the office onboarding screens require an **administrator**. A collector is
  refused with *"Only an administrator can import customers in bulk."* Collectors keep their
  own field-registration action, which is scoped to their own branch.
- Every batch read and write carries `tenantId`, so another tenant's batch id yields
  *"Import batch not found."* — the same answer as a non-existent id.
- Branch scope is resolved by Phase 1 (`resolveBranchScope`) and enforced twice: when the
  destination branch is chosen (`resolveWriteBranch`), and per row during validation
  (`branch_unauthorised` when a row names a branch outside the operator's scope).
- `branchMode` is **derived, not asked for**: a mapped `branchRef` column means
  `row_column`; otherwise `single_branch` with the batch's branch.
- A tenant with zero `Location` rows imports with `branchId = null`, matching Phase 1's
  branchless behaviour (`allowUnassignedBranch`). A tenant with branches but no explicit
  choice fails closed.
- Rate limits: `susu:import:create`, `:validate`, `:resolve`, `:commit`, each with
  `RATE_LIMITS.financeMutation`-style policy via `consumeRateLimit`.

---

## 9. Financial integrity guarantees

Restated as test assertions, not intentions:

1. A committed import creates `Customer`, `SusuAccount` and one `SusuCycle` per account —
   and **zero** `Contribution`, `Withdrawal`, `Commission` or `CardFee` rows.
2. No import updates an existing balance. An account that already exists is only ever linked
   or excluded, never edited.
3. `openingDate` is preserved exactly when given, and left `NULL` when not — never filled
   with the import date.
4. Cycle 1 always starts in the current month, whatever the historical opening date, so
   MaaCash never claims to have been collecting in months it did not exist.
5. `commissionCharged` is false on the first cycle; commission is Phase 3's business.
6. A card fee is only recorded when an operator explicitly states one was sold (office
   onboarding). Import never records one.

---

## 10. Audit trail and observability

| Action | Level | Recorded |
| --- | --- | --- |
| `susu.customer_import_batch_created` | batch | file name, hash, size, branch mode, headers |
| `susu.customer_import_validated` | batch | mapping, counts, branch mode |
| `susu.customer_import_rows_resolved` | batch | row, from/to resolution, note |
| `susu.customer_import_discarded` | batch | reason |
| `susu.customer_import_committed` | batch | final counters, status |
| `susu.customer_import_customer_created` | row | customer id |
| `susu.customer_import_account_linked` | row | customer + account id |
| `susu.customer_created` | office | customer, branch, channel |
| `susu.account_opened_for_customer` | office | existing customer, account, branch |
| `susu.customer_created_by_collector` | field | collector, branch, customer |

No audit detail contains a password, a token, or a full source row beyond what the operator
supplies as customer data.

---

## 11. Files, surfaces and navigation

New server modules:

- `src/lib/susu/onboarding.ts` — identity and account write path.
- `src/lib/susu/import-csv.ts` — RFC-4180 CSV parser, delimiter detection, hashing, template.
- `src/lib/susu/import-validation.ts` — field catalogue, mapping, classification, issues.
- `src/lib/susu/import-commit.ts` — plan digest, readiness, lease, chunked commit.
- `src/lib/actions/susu-onboarding.actions.ts` — office registration, additional account,
  candidate search, options.
- `src/lib/actions/susu-import.actions.ts` — the nine import actions.

New screens:

- `src/app/susu/admin/onboarding/page.tsx` — search-before-create, then the registration form
  (or the "open another account" form for a matched person).
- `src/app/susu/admin/imports/page.tsx` — the four-step wizard plus import history and the
  error-report download.

Navigation: `src/lib/admin-nav.tsx` gains *Register Customer* and *Customer Import* in the
Susu section, after *Customers*.

Modified: `src/lib/actions/susu-customer.actions.ts` (delegates to `onboarding.ts`),
`src/lib/actions/susu-collector.actions.ts` (same), `tests/setup.ts` and `tests/pg-setup.ts`
(cleanup order for the three new tables), `prisma/schema.prisma`, `prisma/schema-pg.prisma`.

---

## 12. What later phases may assume, and known limitations

Later phases may rely on:

1. `Customer` is the person; `SusuAccount` is the account; branch lives on the account.
2. `SusuAccount.branchId` is set at creation and never moved by a later branch change.
3. `openingDate` is trustworthy when present and `NULL` when unknown.
4. Every imported account is linked to its batch through `importBatchId`, and every imported
   customer through the row table — provenance is reconstructible.
5. A row that failed during a commit carries `outcome = "failed"` and a readable
   `outcomeMessage`; re-running the commit retries only rows without an outcome.

Known limitations, recorded rather than hidden:

- **No `.xlsx`.** An Excel file must be saved as CSV first; the upload refuses it by name.
- **No automatic merge** of two existing customer records, and no split. Both are manual
  operations a later phase must add with their own audit.
- **Cycle 1 always starts in the current month.** An account imported with a 2023 opening date
  will not show 2023 cycles; that is intentional, but it means historical monthly reporting
  cannot be reproduced from an import.
- **`sourceText` is cleared on commit/cancel.** A committed batch cannot be re-validated;
  its parsed rows are the record of what was in the file.
- **A commit is chunked, not a single transaction.** A crash mid-commit leaves
  `partially_committed` with honest counters; the operator re-runs the commit to finish, and
  already-written rows are never duplicated.
- **Duplicate detection is deterministic, not fuzzy.** "Ama Boateng" and "Ama Boeteng" are two
  rows; the review screen shows both and the operator decides.
- **Branch attribution for a branchless tenant is `NULL`.** Phase 1's
  `LEGACY_UNASSIGNED_BRANCH` remains the read-time label, not a stored value.

---

## Verification performed

| Gate | Command | Result |
| --- | --- | --- |
| Unit and action suite | `npm test` | 171 files, 1,963 tests passed |
| Phase 7 suite | `npx vitest run tests/susu-phase-7.test.ts` | 32 tests passed |
| PostgreSQL parity | `npx vitest run --config vitest.pg.config.ts tests/pg-susu-phase-7.test.ts` | 5 tests passed |
| Types | `npm run typecheck` | clean |
| Schema | `npx prisma validate` (both schemas) | valid |
| Migration | `migrate deploy` on disposable PG 16 | applied |

The PostgreSQL database used was a disposable Docker container
(`maacash-phase7-pg`, `127.0.0.1:55470`), guarded by `PG_TEST_CONFIRM=DISPOSABLE_TEST_DATABASE`.
No hosted database was contacted.
