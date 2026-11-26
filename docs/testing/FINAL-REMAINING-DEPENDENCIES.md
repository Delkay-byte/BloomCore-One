# Final remaining dependencies

Everything still open after local acceptance, classified so that no internal engineering
work hides in the list and no external dependency is misreported as a missing feature.

Statuses used, exactly:

| Status | Meaning |
| --- | --- |
| **PASS** | Implemented, tested locally, evidence recorded |
| **FAIL** | Implemented and failing — none remain |
| **OWNER MANUAL TEST REQUIRED** | Works in software; needs a physical device or a human decision to sign off |
| **BLOCKED_EXTERNAL** | Cannot be completed without a third party (contract, credentials, approval) |
| **ASSOCIATION DECISION REQUIRED** | Needs MoMAG/MMAAG policy input, not code |

Companion documents: [LOCAL-FINAL-ACCEPTANCE-REPORT.md](./LOCAL-FINAL-ACCEPTANCE-REPORT.md) ·
[COUNTER-COMPANION-ANDROID-ACCEPTANCE.md](./COUNTER-COMPANION-ANDROID-ACCEPTANCE.md) ·
[E2E-SKIPPED-TESTS-REVIEW.md](./E2E-SKIPPED-TESTS-REVIEW.md) ·
[Risk intelligence privacy review](../privacy/SHARED-AGENT-RISK-INTELLIGENCE-PRIVACY-GOVERNANCE-REVIEW.md)

---

## 1. Internal scope — closed

| Area | Status | Evidence |
| --- | --- | --- |
| Daily accountability, corrections, reversals, shifts, handovers | PASS | 153 unit files / 1780 tests; browser suite |
| Reconciliation: statement import, matching, exception cases, liquidity | PASS | gate + `tests/provider-statement.test.ts`, `tests/reconciliation-liquidity.test.ts` |
| Counter Companion (four flows, masking, PIN refusal, permissions) | PASS (software) / OWNER MANUAL (device) | `tests/counter-companion.test.ts`; device sheet §6 |
| Offline MoMo capture lifecycle | PASS | `tests/offline-momo-drafts.test.ts` (18) |
| Offline requests and device enrolment | PASS | `tests/offline-requests.test.ts` |
| Closed-loop evidence and provenance levels | PASS | `tests/evidence-provenance.test.ts` (16) |
| Employee accountability and anomaly investigation | PASS | `tests/employee-accountability.test.ts`, `tests/anomaly-investigation.test.ts` |
| Branch liquidity forecasting (read-only) | PASS | `tests/liquidity-forecast.test.ts` (18), `tests/liquidity-forecast-acceptance.test.ts` (4) |
| Association governance, sponsorship, training panels | PASS (code) / ASSOCIATION DECISION (policy) | panel tests; §4 below |
| Consolidated reporting, Susu, customer portal | PASS | gate + browser suite |
| Zeli explanation drafts, conversation entitlement | PASS | `tests/zeli-*` |
| AI Investigation add-on (paid, per business, manual activation path) | PASS (code) / BLOCKED_EXTERNAL (live AI) | `tests/ai-investigation-*.test.ts` |
| Pricing catalogue, repricing, renewal notices | PASS | `tests/pricing*`, `tests/billing-lifecycle*` |
| Shared agent risk intelligence (opt-in register) | PASS (code) / **do not enable** until §3 decisions | 34 tests; privacy review §24 |
| Final gate steps and browser acceptance | PASS individually | every gate step passes on its own; the long gate process is unstable on this machine (§5.1 of the acceptance report) |
| Physical-device PWA workflows | **OWNER MANUAL TEST REQUIRED** | no device attached to this machine |
| Production-host checks (6 browser tests) | **BLOCKED_EXTERNAL** | need a deployed origin; see skips review §2.1 |

## 2. External dependencies

Each row states what is actually missing, and what already works without it.

| Dependency | Status | What is already built and tested | What the third party must provide | Effect while blocked |
| --- | --- | --- | --- | --- |
| **MTN provider connection** (provider-confirmed transactions, live float/statement feed) | **BLOCKED_EXTERNAL** | Statement import and matching, exception cases, provenance levels that stop one step short of `provider_confirmed` | An approved integration or a licensed data feed, with credentials and terms | Transactions remain `operator_recorded`; confirmation is impossible and the product says so. Nothing else is blocked. |
| **Telecel provider connection** | **BLOCKED_EXTERNAL** | Same as MTN | Same | Same |
| **AT Money provider connection** | **BLOCKED_EXTERNAL** | Same as MTN | Same | Same |
| **WhatsApp provider setup and approvals** | **BLOCKED_EXTERNAL** | Full messaging architecture: consent, outbox, dispatch route, status webhooks, per-business templates, 13 documented env vars, operator checklist | Meta Business verification, phone number, template approvals, delivery enablement | Delivery stays off (`WHATSAPP_DELIVERY_ENABLED=false`). No "Coming soon" badge is shown over WhatsApp, because the owner is building it — the readiness row says so in words. |
| **SMS provider** | **BLOCKED_EXTERNAL** | Same messaging layer, SMS status webhook, provider abstraction | A provider contract and credentials | Marked "Coming soon" in the product (`id: "sms"`). |
| **Banking** | **BLOCKED_EXTERNAL** (not contracted; not in current scope) | Readiness row exists, `delivers: false` | A bank integration partner | Marked "Coming soon". No workflow depends on it. |
| **Accounting export** | **BLOCKED_EXTERNAL** (not contracted) | CSV export and reporting exist independently | A target accounting product's API or format agreement | Marked "Coming soon". |
| **Identity verification (KYC)** | **BLOCKED_EXTERNAL** (not contracted) | Staff and customer records with roles and statuses | A licensed identity provider | Marked "Coming soon". |
| **Provider payment status** (live status callbacks) | **BLOCKED_EXTERNAL** | Paystack checkout, verified webhooks, subscription fulfilment, automatic add-on activation on verified payment; provider credentials blanked in the browser suite | The provider's production account/approval | Marked "Coming soon" for the telco status feed; subscription payments already work through the existing verified path. |
| **External AI service** (Zeli conversation and AI Investigation) | **BLOCKED_EXTERNAL for live calls**; code path PASS | Deterministic explanation fallback always works; conversation entitlement and investigation entitlement implemented and tested; provider refuses to run under `NODE_ENV=test`; 20s timeout, bounded reads, grounding checks, fallback reasons | A provider key plus the owner's security/financial-evidence review of the external model | With no key, Zeli answers from records deterministically and the panel says why. No capability silently disappears. |

Nothing in this table is an internal engineering gap. Each is a contract, a credential or an
approval that only the owner can obtain.

## 3. Governance and legal decisions (not engineering)

| Item | Status | Why it cannot be closed here |
| --- | --- | --- |
| Shared risk intelligence: lawful basis, controller configuration, subject notice and rights, challenge procedure, retention ceiling, minimum network size for disclosure, salt custody/rotation, DPC registration, defamation review, incident runbook | **OWNER / LEGAL DECISION REQUIRED** (12 enumerated items) | These are legal and operational determinations. See the privacy review §24. |

The register is disabled until the salt is configured, and configuring it without these
decisions would be a governance failure. This is a decision, not a defect.

## 4. Association decisions

These block **association-specific use cases only**. They do not block the general MaaCash
release: no MoMo or Susu workflow, no reconciliation, no reporting and no customer portal
depends on them.

| Decision | Status | What is already built | What it blocks | Does it block general release? |
| --- | --- | --- | --- | --- |
| **Pilot dashboard audience and reporting** (which association officers see which businesses' aggregates) | **ASSOCIATION DECISION REQUIRED** | Association governance model, member records, consolidated reporting, role-scoped export route | The association pilot dashboard's audience and disclosure scope | **No** |
| **Sponsorship funding and liability policy** (who funds sponsored subscriptions, who is liable, tax and credit-note treatment) | **ASSOCIATION DECISION REQUIRED** | Append-only integer-pesewa funding and release ledger, sponsored-subscription records, audit trail | Enabling sponsorship at association scale; tax/credit-note handling | **No** |
| **Training and certification standards** (official competencies, assessor authority, certificate validity) | **ASSOCIATION DECISION REQUIRED** | Training records, assessment results, certificate verification page, public verification by token | Issuing recognised certificates under MoMAG/MMAAG authority | **No** |

Each is recorded in the code as *facts* rather than guessed policy, and each is marked
`PENDING_ASSOCIATION_DECISION` in the audit register.

## 5. Owner manual acceptance still required

| Item | Why it needs a human |
| --- | --- |
| Physical-device PWA workflow (13 steps in the Android acceptance sheet) | No Android device is attached to this machine (`adb` absent, no APK exists); the product is a PWA |
| SIM/network-specific behaviour for MTN, Telecel and AT Money | Requires physical SIMs and network apps |
| Device persistence of the offline queue across a browser restart | IndexedDB behaviour is browser- and OS-specific |
| Production-host browser checks (6 tests) | Require a deployed origin, which this programme is not permitted to contact |
| Whether `maacash-evidence` should run in the release checklist | An owner preference on committed evidence images |

## 6. Release operations, not started by design

| Operation | Status |
| --- | --- |
| Push `feat/maacash-momag-readiness` | NOT PERFORMED — requires owner authorisation |
| Open a pull request / review the 380-file diff | NOT PERFORMED |
| Provision the PostgreSQL schema with the migration chain | NOT PERFORMED — rehearsed locally only |
| Configure Render environment variables | NOT PERFORMED |
| Deploy and smoke-test each role | NOT PERFORMED |
| Enable features one at a time and verify | NOT PERFORMED |
| Run the six production-host browser checks | NOT PERFORMED — depends on deployment |

## 7. Summary

| Status | Count |
| --- | ---: |
| PASS (internal engineering) | all internally implementable scope |
| FAIL | **0** |
| OWNER MANUAL TEST REQUIRED | 5 items (§5) |
| BLOCKED_EXTERNAL | 9 provider/service dependencies (§2) |
| OWNER / LEGAL DECISION REQUIRED | 1 register-wide governance package, 12 sub-items (§3) |
| ASSOCIATION DECISION REQUIRED | 3 (§4) — association use cases only |

**No unrecorded internal engineering work remains.** What is left is a set of contracts,
approvals, legal determinations, association policies, one physical-device acceptance run,
and the release operations the owner will authorise next month.
