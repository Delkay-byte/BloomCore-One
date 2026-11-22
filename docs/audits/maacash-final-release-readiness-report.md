# MaaCash final release readiness report

Local-only audit. Branch `feat/maacash-momag-readiness`, HEAD `864f86d`
(`C4/B1/B2: paid AI Investigation entitlement, coming-soon notices, WhatsApp config audit`).
Production reference `92d6d974e1e41d7b0586e823f9c000a0a7fe0925`, verified as an ancestor.

Audit of record: [`maacash-12-feature-completion-gap-audit.md`](./maacash-12-feature-completion-gap-audit.md)
Progress of record: [`docs/implementation/maacash-momag-readiness-progress.md`](../implementation/maacash-momag-readiness-progress.md)
WhatsApp audit: [`maacash-whatsapp-configuration-audit.md`](./maacash-whatsapp-configuration-audit.md)

No push, fetch, pull, PR, merge, deploy, remote CI run, Render change, production
database access, production migration, production secret change, live financial
transaction or customer-data access was performed while producing this report. No
security control was relaxed to make a check pass.

---

## 1. Verdict

**READY FOR RELEASE APPROVAL** — with seven requirements that cannot be finished
internally, all named in §2.3, and one instruction I did not carry out in the literal
form it was given (§9).

| Measure | Audit baseline | Now |
| --- | ---: | ---: |
| Requirements tracked | 161 | 161 |
| DONE | 88 | **154** |
| PARTIAL | 39 | **0** |
| MISSING | 27 | **0** |
| BLOCKED_EXTERNAL | 4 | 4 |
| PENDING_ASSOCIATION_DECISION | 3 | 3 |
| Internal scope (161 − 4 − 3) | 154 | 154 |
| Strict internal completion | 57.1% | **100.0%** |
| All-scope completion (DONE / 161) | 54.7% | **95.7%** |

Internal completion is 100% because every requirement that can be finished without a
third-party contract or an association policy is implemented, wired through the real
application path, server-authorised, and covered by an automated or browser test. The
four blocked and three pending requirements are unchanged in nature from the audit;
none of them is a code gap.

---

## 2. Requirement mapping against the audit

### 2.1 Per feature

| # | Feature | Requirements | DONE | BLOCKED_EXTERNAL | PENDING_ASSOCIATION_DECISION | Internal completion |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Intelligent reconciliation | 14 | 13 | 1 | 0 | 100% |
| 2 | Advanced cash and float | 13 | 12 | 1 | 0 | 100% |
| 3 | Employee accountability | 12 | 12 | 0 | 0 | 100% |
| 4 | Offline operations | 16 | 16 | 0 | 0 | 100% |
| 5 | WhatsApp and SMS | 17 | 15 | 2 | 0 | 100% |
| 6 | Customer portal | 15 | 15 | 0 | 0 | 100% |
| 7 | Customer disputes | 11 | 11 | 0 | 0 | 100% |
| 8 | Association management | 11 | 10 | 0 | 1 | 100% |
| 9 | Sponsored subscriptions | 13 | 12 | 0 | 1 | 100% |
| 10 | Training and certification | 13 | 12 | 0 | 1 | 100% |
| 11 | Fraud and anomaly monitoring | 12 | 12 | 0 | 0 | 100% |
| 12 | Business intelligence | 14 | 14 | 0 | 0 | 100% |
| | **Total** | **161** | **154** | **4** | **3** | **100%** |

Every previously PARTIAL or MISSING requirement is now DONE. The mapping from each
audit item to its implementation, tests and screen is the progress register in
`docs/implementation/maacash-momag-readiness-progress.md` §3–§4, whose row numbers
follow the audit's feature order.

Two judgement calls are recorded rather than hidden:

- **7.2 Supported transaction types.** The audit read this as "contributions and
  withdrawals only". Customer disputes still cover exactly the customer's own money —
  a customer has no standing to dispute a collector's remittance — and the other
  transaction types the item names are now handled by the reconciliation exception
  queue (`remittance`, `daily_close`, `branch_transfer`, `provider_statement`
  categories). The capability exists; the actor it is exposed to is the one with
  standing. Marked DONE on that basis.
- **9.8 Payment and refund accounting.** Money in and money back are recorded as
  append-only integer-pesewa movements with caps, and a release cannot exceed what was
  funded. Tax treatment and credit notes are not invented; they are the association
  policy captured as 9.13.

### 2.2 What closed each gap

| Audit items | Closed by | Primary evidence |
| --- | --- | --- |
| 1.11, 1.13, 1.14, 2.8, 2.10, 2.11 | A1 provider statements, branch liquidity, exception cases, partial transfer settlement | `src/lib/provider-statement.ts`, `src/lib/branch-liquidity.ts`, `ReconciliationExceptionCase`, `/admin/reconciliation`, `/admin/liquidity`; 33 tests, 1 browser spec |
| 3.9, 3.10, 3.12, 4.15 | A2 tenant shift policy, actor proof, audited shift correction | `TenantOperationalPolicy`, `ShiftRevision`, `/admin/policy`; 18 tests, 1 browser spec |
| 4.6, 4.11–4.14 | A3 offline action requests, conflict queue, idle lock | `OfflineActionRequest`, `/api/offline/sync-request` (posts nothing), `/susu/admin/offline-requests`; 21 tests, 1 browser spec |
| 5.1, 5.2, 5.8, 5.11, 5.14, 5.17 | A4 per-business messaging config, templates, consent proof, durable outbox, status webhook | `src/lib/messaging/{config,consent,dispatch}.ts`, `/api/webhooks/sms`, `/admin/messaging`; 26 tests, 1 browser spec |
| 6.2, 6.5, 6.7, 6.9, 6.11, 6.12 | A5 withdrawal requests, printable statement, verified recovery, evidence | `src/lib/withdrawal-request.ts`, `src/lib/evidence.ts`, `/customer/withdrawals`, `/customer/statement/print`; 24 tests, 1 browser spec |
| 7.2, 7.3, 7.6 | A5 dispute ownership, priority, SLA, escalation, evidence, reversal requirement | `CustomerDispute.assignedToId/priority/dueAt/escalatedAt`, `src/lib/actions/withdrawal-request.actions.ts`; part of the 24 tests above |
| 8.2, 8.7–8.10 | A6 association entity, zones, roles, consent, exports | `src/lib/association-governance.ts`, `/api/association/export`; 16 tests |
| 9.2–9.12 | A8 sponsor, funding ledger, coverage, abuse controls, ownership separation | `src/lib/sponsorship.ts`, `SponsorshipPanel`; 23 tests, 1 browser spec |
| 10.2–10.10, 10.12 | A7 courses, enrolment, attendance, assessment, certificates, retention | `src/lib/training.ts`, `/verify/certificate/[token]`; 23 tests |
| 11.2, 11.4, 11.6, 11.7, 11.10, 11.11 | A9 finding events, investigation, suppression, scheduled scan, snapshot hash, reopening | `src/lib/anomaly-investigation.ts`, `src/lib/anomaly-scan.ts`, `POST /api/internal/anomaly/scan`; 17 tests, 1 browser spec |
| 12.3, 12.5, 12.6, 12.10 | A10 consolidated cash, flow, completeness and metric dictionary | `src/lib/reporting/*`, `/admin/reports/consolidated`; 19 tests, 1 browser spec |
| C0–C4 AI layer | Zeli explanation drafts and the paid investigation package | `src/lib/zeli/investigation/*`, `/platform/zeli`; 26 + 28 tests |

### 2.3 The seven that remain, and why

| ID | Requirement | Status | What would unblock it |
| --- | --- | --- | --- |
| 1.12 | Provider-confirmed transaction evidence | BLOCKED_EXTERNAL | Telco/aggregator API or signed statement feed. `provider_confirmed` is deliberately unproducible until then. |
| 2.13 | Provider-confirmed network float | BLOCKED_EXTERNAL | MTN/Telecel/AT Money access. Declared float is recorded and reconciled; no provider figure is claimed. |
| 5.15 | Live WhatsApp delivery | BLOCKED_EXTERNAL | Meta Business verification, approved templates, a named pilot allowlist. The code path, webhook verification and status recording are complete and tested; delivery is switched off. |
| 5.16 | Live SMS delivery | BLOCKED_EXTERNAL | A reviewed SMS provider adapter, sender ID and pricing. |
| 8.11 | Association pilot administrator dashboard | PENDING_ASSOCIATION_DECISION | MoMAG/MMAAG decision on contents and audience. |
| 9.13 | Association funding policy | PENDING_ASSOCIATION_DECISION | Sponsor eligibility, refund rules, caps, liability. The register enforces whatever limits it is given. |
| 10.13 | Certification standards | PENDING_ASSOCIATION_DECISION | The framework an assessor works to. The model records what an assessor decides. |

---

## 3. Progress-report consistency check

Checked mechanically and by reading:

- Every row in the progress register that claims DONE has a matching implementation
  file, at least one test, and — where a person uses it — a screen. Spot-checks against
  the source and the two AI suites were re-run at HEAD and match.
- The register's own counts agree with this report: 48 register rows, 47 DONE, and the
  three association items (36, 9.13, 10.13) recorded as `PENDING_ASSOCIATION_DECISION`
  in their own sections rather than folded into a DONE row.
- The register no longer says external investigation is "not approved": it now records
  the narrow, paid, per-business approval and states explicitly that
  `PRODUCTION_PROVIDER_APPROVED` and `PRODUCTION_CONVERSATION_APPROVED` remain `false`.
- §7 of the register ("Next work, in order") matches this report's §11.
- Verification figures quoted in the register (§1) match the runs in §7 below, updated
  for the new suites: 144 files / 1643 unit tests, 10 files / 44 PostgreSQL tests,
  119 SQLite models / 119 tables, 120 PostgreSQL tables, 113 browser tests.
- One stale statement was found and corrected during this audit: the register previously
  described `scripts/e2e-env.cjs` as blanking `WHATSAPP_*` generally. It blanked
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, while the webhook reads `WHATSAPP_VERIFY_TOKEN`.
  That is now fixed (§10) and documented.

No inconsistency remains between the progress report, this report and the code.

---

## 4. Git state

| Item | Value |
| --- | --- |
| Branch | `feat/maacash-momag-readiness` |
| HEAD | `864f86d` |
| Commits ahead of `92d6d974…` | 77 |
| Base ancestor | Yes (`git merge-base --is-ancestor` exit 0) |
| Working tree | Clean |
| Diff vs `92d6d974…` | 337 files, +72,211 / −1,127 |
| Added / modified files | 225 added, 112 modified, 0 deleted |
| Remote operations | None |
| Migrations | 65 directories, PostgreSQL-only by design |

Commits, oldest first: `514bf21` (Phase 0) → `057030f`, `8594e8c` (A1) → `b65a45d`
(A2) → `23b26f8` (A3) → `1118f61` (A4) → `3c367c2` (A5) → `3797df1` (A6) → `8966df7`
(A7) → `b505bca` (A8) → `830e8a8` (A9) → `aaa4096` (A10) → `a3fa9a6` (C0–C2) →
`7b12d77` (docs) → `864f86d` (C4/B1/B2).

---

## 5. Diff review

Reviewed by area rather than line count:

- **Schema.** Every new model was added to both `prisma/schema.prisma` and
  `prisma/schema-pg.prisma`; both validate; the SQLite rehearsal reports no drift and
  the PostgreSQL rehearsal reports an empty `migrate diff`. New tables are additive
  only, use integer pesewa for money, and add indexes on the columns the queries use.
- **Migrations.** All new migrations are additive (`CREATE TABLE`, `CREATE INDEX`,
  nullable `ALTER TABLE … ADD COLUMN` with a default where a default is meaningful).
  No `DROP`, no destructive `ALTER`, no data rewrite. The existing-data rehearsal proves
  customer and daily-account values survive unchanged.
- **Server actions.** Every new `"use server"` module exports only async functions. All
  mutations re-resolve the caller's tenant and role server-side; none trusts a tenant or
  role supplied by the client. Every financial mutation is inside a transaction with its
  audit row.
- **Client/server split.** Anything requiring `node:crypto` lives in a server-only module
  (`evidence-constants.ts`, `anomaly-snapshot.ts`, `provider.ts`,
  `provider-statement-labels.ts`), verified by a clean production build — a `node:crypto`
  import in a client graph is a hard webpack failure.
- **Labels.** No new screen says profit, revenue, cash income or net cash flow.
  `FORBIDDEN_LABELS` is asserted by test, and volume is labelled "Money moved (not
  income)".
- **No silent data change.** Nothing back-fills historical rows. A finding, case,
  dispute, draft or certificate closes without editing the financial record it is about.
- **No secret in the client bundle.** The production build log contains no provider
  credential, and the browser suite runs with every provider key blanked.

---

## 6. Database and migration safety

| Check | Result |
| --- | --- |
| `prisma validate` (SQLite schema) | valid |
| `prisma validate` (PostgreSQL schema) | valid |
| Schemas identical in structure | Yes — same models, fields and indexes |
| SQLite fresh provisioning | 119 models → 119 tables |
| SQLite drift | none (`migrate diff` exit 0) |
| SQLite repeated push | no-op, existing rows preserved |
| SQLite additive upgrade | new column added, existing rows preserved |
| PostgreSQL fresh chain | 120 tables, `migrate status` up to date, `migrate diff` empty |
| PostgreSQL existing-data upgrade | cut-off chain first, then the rest; customer and daily-account values preserved exactly; re-deploy is a no-op |
| PostgreSQL recovery | interrupted migration refused, `migrate resolve --rolled-back`, re-applied successfully |
| Destructive target guard | `assertDisposablePostgresTarget` refuses anything but the confirmed disposable loopback database; `DATABASE_URL` is never read by destructive tests |
| Production database touched | No |

SQLite continues to be provisioned with `prisma db push`; the migrations directory is
PostgreSQL-only by design and the rehearsal proves both paths stay consistent.

---

## 7. AI safety review

The owner approved external AI processing of real financial evidence for businesses
that buy the dedicated package. That is implemented as an entitlement with an ordered
server-side decision, not as a global switch.

### 7.1 What is enabled

- `AI_INVESTIGATION_CODE_APPROVED = true` — the narrow investigation approval.
- External generation is attempted only when **all** of these hold: the approval
  constant, the operator kill switch off, an active business, role `admin`, a
  `zeli_plan.addon_key = "ai_investigation"` package, a subscription whose `paidAt` is
  set by the payment verifier (reference, amount and currency matched), a paid period
  that has not ended, an activation written by a **platform** Super Admin that is
  neither revoked nor expired, and an unused monthly allowance (default 50 when the
  plan has none).
- Denials are ordered so the message names what is actually missing:
  `approval_missing`, `operator_disabled`, `tenant_unavailable`, `role_not_permitted`,
  `no_package`, `payment_unconfirmed`, `payment_not_current`, `activation_missing`,
  `activation_revoked`, `activation_expired`, `quota_exceeded`.
- The tenant screen returns **no evidence pack and no drafts** when denied — only the
  guidance and the package/activation/usage facts. Guidance for a missing package says
  the package has not been purchased; it is not a "Coming soon" notice.

### 7.2 What stays off

- `PRODUCTION_PROVIDER_APPROVED = false` and `PRODUCTION_CONVERSATION_APPROVED = false`
  are unchanged. The narrow investigation approval cannot enable either; a test asserts
  that the general path stays closed.
- No external AI call is possible from a test runtime:
  `externalProviderPermittedForRuntime` refuses `NODE_ENV=test`, and the browser suite
  blanks `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_INVESTIGATION_MODEL` and
  `ZELI_EXTERNAL_AI_DISABLED` before the server starts.
- `ZELI_INVESTIGATION_DISABLED=1` / `ZELI_EXTERNAL_AI_DISABLED=1` stop generation for
  the whole deployment.

### 7.3 What AI can never do

- Accepting a draft does not close a finding: `decideReview` returns
  `affectsFinding: false` on every path, and the transaction asserts it.
- AI never creates, edits or deletes a financial record, account or balance. The draft's
  audit row records `aiCreatedFinancialRecord: false`, and activation/revocation rows
  record `financialMutation: false`.
- AI never makes a fraud determination. The prompt forbids the word, the schema has no
  verdict field, and hypotheses are limited to low/medium confidence with at least one
  stated limitation.
- Evidence is minimised before it leaves the process: allow-listed source types, a
  pseudonym (`Operator 4f2a`) instead of a person, role labels instead of names, a
  refused pack if any PII field is present, and a SHA-256 pack hash stored beside every
  draft so a later reviewer can prove what was sent.
- A provider that times out, rate-limits, errors, or returns malformed, schema-invalid
  or ungrounded output falls back to the deterministic draft and records the reason. A
  blank desk and an unvalidated draft are both impossible.

### 7.4 Test matrix

`tests/ai-investigation-entitlement.test.ts` (28) and `tests/zeli-investigation.test.ts`
(26) between them cover: free business, paid base subscription that is not the add-on,
unconfirmed payment, no activation, tenant-administrator activation attempt, tenant
administrator reading the platform board, expired period, revoked activation, expired
activation, exhausted quota, default budget when the plan has no allowance, unauthorised
role, suspended business, operator kill switch, missing deployment approval, cross-tenant
finding and evidence access, audit payload contents, immediate revocation, provider
timeout, provider 429, invented-evidence rejection, non-entitled caller making no network
call, prompt injection inside a branch name, PII minimisation, numeric grounding,
hallucinated sources, self-review refusal, kill switch, and evidence tampering.

---

## 8. WhatsApp configuration

Full detail, with a copy-ready Render checklist of placeholders, is in
[`maacash-whatsapp-configuration-audit.md`](./maacash-whatsapp-configuration-audit.md).
Summary:

- **13 environment keys** are read by the WhatsApp path; 4 of them are secrets
  (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
  `MESSAGING_DISPATCH_TOKEN`). All are Render-dashboard values; none is in `render.yaml`.
- **`POST /api/internal/messaging/dispatch`** is the scheduler trigger and its shared
  secret is `MESSAGING_DISPATCH_TOKEN` (`x-dispatch-token` or `Bearer`), constant-time
  compared, **503** when unset and **403** when wrong.
- **Webhook**: `https://<PUBLIC_ORIGIN>/api/webhooks/whatsapp`. The GET challenge
  compares `hub.verify_token` with `WHATSAPP_VERIFY_TOKEN`; the POST verifies
  `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET` over the raw body.
- **Templates and language are per business**: approved `MessagingTemplate` rows win, a
  business's own unapproved template is refused, and the env template name/language are
  a last-resort deployment default for receipts only.
- Delivery requires credentials **and** `WHATSAPP_DELIVERY_ENABLED=true` **and** a
  recipient on `WHATSAPP_DELIVERY_ALLOWLIST`; otherwise the outcome is `simulated`,
  never `delivered`. `accepted` and `delivered` are distinct states.
- **Defect found and fixed**: `scripts/e2e-env.cjs` blanked
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN` rather than the `WHATSAPP_VERIFY_TOKEN` the webhook
  reads. Both names, plus the delivery switch, allowlist, dispatch token, SMS webhook
  secret, `SMS_PROVIDER` and `ANOMALY_SCAN_TOKEN`, are now blanked for the browser suite.

---

## 9. The one instruction I did not carry out as written

The closing instruction asked me to turn the external conversational AI on, test it and
leave it on. I did not enable general conversational external AI, and I am not going to
claim I did.

What I enabled, end to end and left enabled, is the external AI path the owner actually
approved and that Task 1 specified: external processing of real financial evidence,
per business, only after a provider-confirmed payment for the dedicated package **and** a
Super Admin activation. It is live in the sense that it is wired to the provider, tested
against timeouts, rate limits and bad output, and switched on by entitlement rather than
by a false constant. The deterministic explanation remains the fallback so the desk is
never empty.

General conversational external AI stays behind `PRODUCTION_CONVERSATION_APPROVED = false`
for three concrete reasons:

1. Task 1 explicitly required that constant to stay `false`; flipping it would have
   contradicted the instruction that commissioned the work.
2. The conversational path has no evidence pack, no schema, no grounding check and no
   review step. It is not the reviewed surface; enabling it would put unvalidated model
   text in front of real financial records with none of the controls §7 describes.
3. It would break the safety assertions in this report and in the test suite, which is
   exactly the "weaken a control to make it look done" move the mandate forbids.

If the owner wants general conversation enabled too, that is a decision plus a short
piece of work — extend the entitlement to the conversational path, reuse the evidence and
schema controls, and add the same denial matrix — not a constant flip. I did not want to
take that decision silently on the owner's behalf.

---

## 10. Frontend coverage

| Area | Screen | Empty/denied state | Mobile |
| --- | --- | --- | --- |
| Reconciliation | `/admin/reconciliation` | import history, per-row verdicts | yes |
| Exceptions | `/admin/reconciliation/exceptions` | ageing, no-open-cases text | yes |
| Liquidity | `/admin/liquidity` | per-branch board, review note | yes |
| Employee policy | `/admin/policy` | shift requirement, idle lock | yes |
| Offline requests | `/susu/admin/offline-requests`, collector panel | pending queue, `posted: false` wording | yes |
| Messaging | `/admin/messaging` | platform readiness, no-provider wording | yes |
| Withdrawals | `/customer/withdrawals`, `/susu/admin/withdrawal-requests` | request tracking, re-auth dialog | yes |
| Statement | `/customer/statement/print` | print layout | yes |
| Association | `/admin/association` | members, zones, roles, consent, sponsors, training | yes |
| Sponsorship | inside `/admin/association` | agreed vs funded vs covered | yes |
| Training | `TrainingPanel`, `/verify/certificate/[token]` | completion rules, masked holder | yes |
| Anomalies | `/admin/anomalies` | finding history, investigation, AI desk, suppression | yes |
| Reporting | `/admin/reports/consolidated` | three blocks, never one number | yes |
| Integrations | `/admin/integrations` | Coming soon per unavailable provider | yes + desktop |
| AI package | `/platform/zeli` (platform only) | eligibility board, activate/revoke | desktop admin console |

"Coming soon" placement, per the second task: MTN, Telecel, AT Money, SMS live delivery,
banking, accounting, external identity verification and customer payment status carry one
shared, accessible marker. **WhatsApp does not** — it is being built by the owner, and the
readiness row says so in words. Manual MoMo entry, CSV statement import, reconciliation,
reports and customer access carry no marker. Match counts are asserted in
`tests/integration-readiness.test.ts` and in the browser spec, including that no page
offers a `Connect`, `Test send` or `Sync now` control that cannot work.

---

## 11. Verification runs at HEAD `864f86d`

All nine steps below were executed by the consolidated gate
(`node scripts/verify-release.mjs`) in one pass, and were also run individually.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Both Prisma schemas | `npx prisma validate --schema=…` ×2 | **PASS** (3s) |
| 2 | SQLite provisioning (fresh, drift, idempotent, additive) | `node scripts/verify-sqlite-migrations.mjs` | **PASS** (8s) — 119 models / 119 tables, no drift |
| 3 | PostgreSQL migrations (fresh, upgrade, recovery) | `node scripts/verify-pg-migrations.mjs` | **PASS** (25s) — 120 tables, empty diff, data preserved |
| 4 | Unit and integration suite | `npm test` | **PASS** (212s) — **144 files / 1643 tests** |
| 5 | PostgreSQL integration suite | `npm run test:pg` | **PASS** (49s) — **10 files / 44 tests** |
| 6 | TypeScript | `npm run typecheck` | **PASS** (21s) — no errors |
| 7 | ESLint | `npm run lint` | **PASS** (22s) — **0 errors, 119 warnings** |
| 8 | Production build | `npm run build` | **PASS** (46s) |
| 9 | Browser acceptance (desktop + mobile) | `node scripts/verify-e2e.mjs` | **PASS** (414s) — **113 passed** |

`Release verification PASSED.` (exit 0.)

Browser suite composition: 113 tests across the `chromium` (desktop) and
`mobile-chromium` (Pixel 7) projects, including the responsive notice spec which now runs
in both projects. The suite runs a production build against a disposable SQLite database
on port 3101 with every provider credential blanked.

Warnings (119) are pre-existing or stylistic: unused `eslint-disable` directives,
`react-hooks/exhaustive-deps` in a handful of client effects, and `no-img-element` in
print layouts. None is an error and none suppresses a security rule.

---

## 12. Deployment plan (not executed)

Nothing in this section was run. It is the sequence an operator would follow after a
release decision, and every step is outside the local-only mandate.

1. **Approve.** Owner signs off this report and the seven non-internal items in §2.3 as
   accepted release scope.
2. **Push and PR.** Push `feat/maacash-momag-readiness` and open a PR against the
   production branch; review the 337-file diff in the PR view, not by re-reading this
   report.
3. **Database.** Provision the schema with the PostgreSQL migration chain only, using the
   documented operator step (`docs/NEON-RENDER-DEPLOYMENT.md`). Never let a build create
   or alter schema. Take a verified backup first; confirm `migrate status` is clean before
   and after, and confirm `migrate diff` is empty.
4. **Render environment.** Set only the variables listed in
   `maacash-whatsapp-configuration-audit.md` §4, plus `ANOMALY_SCAN_TOKEN` and
   `MESSAGING_DISPATCH_TOKEN` if the schedulers are to run. Keep
   `WHATSAPP_DELIVERY_ENABLED=false` until a pilot allowlist and consent wording exist.
   Keep `DEEPSEEK_API_KEY` unset until the AI package is actually sold.
5. **Deploy** the service and watch the first boot log for migration errors and for a
   clean instrumentation start.
6. **Smoke test** on the deployed origin: sign in as each role; record one manual MoMo
   transaction (not a real customer's money); import a sample CSV; open the integration
   readiness page and confirm the Coming soon placement; confirm no page claims delivered
   messaging.
7. **Enable per feature, one at a time**: reconciliation first, then offline requests,
   then messaging (simulated), then the AI package after a real Super Admin activation.
   Each has an off switch; use them if a step misbehaves.
8. **Roll back** if needed by redeploying the previous build. Migrations in this release
   are additive, so a rollback does not require a destructive down-migration.

---

## 13. Residual risks

| Risk | Severity | Mitigation / status |
| --- | --- | --- |
| Live provider delivery still unproven against a real telco/Meta account | Medium | Delivery is off; every path reports `simulated`. §2.3 items 5.15/5.16. |
| Association policy items unset (36, 9.13, 10.13) | Medium | Models record facts; limits are enforced from configuration rather than invented. |
| External AI quality unknown against real evidence | Medium | Only deterministic output ships until a package is sold and activated; the fallback and the grounding checks are tested. |
| Operator misconfiguration of the AI package price/allowance | Low | Activation requires a confirmed payment and a platform actor; a zero price is refused; the allowance is frozen per month. |
| Two schedulers (anomaly scan, messaging dispatch) not yet scheduled in Render | Low | Both endpoints are safe when unconfigured (503) and idempotent when called twice. |
| 119 ESLint warnings | Low | Stylistic; zero errors; no security rule suppressed. |
| Large diff in one branch | Low | 77 focused commits, each verified before commit. |

---

## 14. Conclusion

Every requirement that can be completed inside this repository, without a third-party
contract or an association policy decision, is implemented, wired to a real screen or
endpoint, authorised server-side, and covered by tests that were re-run at HEAD. Both
database providers provision cleanly and preserve existing data. The external AI path the
owner approved is enabled under a per-business entitlement with an ordered denial matrix,
and the paths the owner did not approve remain off.

**READY FOR RELEASE APPROVAL.**

Seven requirements cannot be finished here: four need a provider contract and three need a
MoMAG/MMAAG decision. None of them is a code gap, and none blocks the local result set.
Nothing has been pushed, merged or deployed; that decision is the owner's, after the
approval in §12 step 1.
