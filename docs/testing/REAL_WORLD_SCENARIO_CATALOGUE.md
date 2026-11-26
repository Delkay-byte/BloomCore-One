# MaaCash real-world scenario catalogue

**Status:** read-only audit. No test was run, added or changed. Scenarios below use only rules
that exist in the repository. Where a rule is not established in code or documentation, it is
marked **UNKNOWN** and must not be invented during test design.

Companion: [TEST_STRATEGY.md](./TEST_STRATEGY.md).

---

## 1. Roles verified from the repository

| Role | How it is represented | Source |
| --- | --- | --- |
| **Anonymous** | No session; public marketing, login, recovery and readiness routes. Protected pages require a session. | `e2e/maacash-landing.spec.ts`, `tests/middleware-boundaries.test.ts`, `tests/public-routes.test.ts`, `docs/security/external-pentest/03-ROLE-AND-AUTHORIZATION-MATRIX.md` |
| **Business admin (tenant administrator / owner)** | `User.role = "admin"`; no separate owner role. `primaryAdminUserId` identifies first admin but grants no extra permission. | `prisma/schema.prisma:22`, role matrix §3 |
| **Worker / MoMo agent** | `User.role = "worker"` with MoMo access; UI labels "Office Staff" / "MoMo Agent". Own location only. | role matrix §3, §44–47; `e2e/helpers.ts:45` |
| **Susu collector** | `User.role = "collector"`; assigned customers only; own offline scope. | role matrix §3, §19–25; `e2e/role-workflows.spec.ts:15` |
| **Customer** | Separate `Customer` record; signs in with phone or Account Number, not email; own portal record only. | `e2e/helpers.ts:17`, role matrix §3, §24 |
| **Platform admin** | `PlatformSuperAdmin`, separate `bik-platform-session`; tenant cookies cannot open `/platform/*`. | role matrix §3, §37; `tests/platform-auth.test.ts`, `e2e/platform.spec.ts` |
| **Privacy grant holder** | Existing tenant admin with an active `RiskPrivacyAccess` grant (`privacy_admin` or `privacy_reviewer`); optional delegation, not a DPO appointment. | `prisma/schema.prisma:3834`, `docs/PRIVACY_SECURITY_AND_DPO_DPS_AUDIT.md:86`, `src/lib/actions/risk-governance.actions.ts:81`, `tests/risk-governance-actions.test.ts` |

No "tenant owner" or "agent" account type exists. No DPO/DPS approval gate exists
(`docs/SECURITY_AND_TEST_REPORT.md` §2). Any scenario requiring a distinct owner role or DPO
signature is out of scope until that rule is created by the owner.

---

## 2. Business rules used here (verified, with source)

| Rule | Source |
| --- | --- |
| Contributions must be a whole number of days, 1–31 per payment; partial amounts rejected. | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2 |
| Withdrawal: finite amount > 0, at most 2 decimals, ≤ 999,999.99; balance checked in one transaction; first-withdrawal commission claimed once. | same, §2 |
| Reversal is an audited compensating row, never an edit/delete; reason 10–500 chars; `reversalOfId` unique. | same, §6 |
| No business-specific withdrawal limits, dual approval thresholds or daily caps exist. | same, §7.3 — **UNKNOWN policy, do not invent** |
| Tenant id comes from the session; all lookups tenant-scoped; foreign ids return 404. | role matrix §32–36; `tests/tenant-isolation.test.ts` |
| Financial mutations rate limited: 60 per 10 min per subject; offline sync 120/min; admin-sensitive 30/10 min; login 20/15 min per IP. | `src/lib/security/config.ts:194–212` |
| Withdrawals on PostgreSQL serialise per account with an advisory lock; replayed idempotency key posts once. | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §5; `tests/pg-withdrawal-concurrency.test.ts` |
| Step-up re-approval is single-use, bound to session, purpose, target and amount context. | `tests/reauth.test.ts`, `tests/pg-step-up.test.ts`, `tests/security-sec04-06-14.test.ts` |
| Offline capture: network in `mtn`/`telecel`/`at_money`; integer pesewa; business date UTC; stale beyond 14 days; device enrolled and authorised within 24 h; one key = one capture; different body under same key = 409; conflict → `needs_review`; apply only to same worker, branch and day, saved after capture. | `docs/product/offline-momo-operations.md` §3–4; `tests/offline-momo-drafts.test.ts` |
| Evidence levels: `agent_declared` → `device_captured` → `evidence_attached` → `statement_matched` → `provider_confirmed`. Nothing in this build produces `provider_confirmed`; imported statements are not provider confirmations; corrections keep the original row. | `docs/product/closed-loop-evidence.md` §2–3 |
| Liquidity forecast is read-only, integer pesewa, cap 180 days, < 21 days falls back to plain average, no history returns zero; upper band is suggested float; no transfer field. | `docs/product/branch-liquidity-forecasting.md` §2–5; `tests/liquidity-forecast-acceptance.test.ts` |
| Risk intelligence: opt-in per policy version; ≥3 distinct contributing businesses, caller's own signals excluded; category needs ≥2 businesses; coarse bands only; 180-day decay; min 10-char internal note; salted hash, no clear identity; missing salt is hard failure; disclosure audited. | `docs/product/shared-agent-risk-intelligence.md` §3; `tests/risk-intelligence*.test.ts` |
| Webhooks: raw-body HMAC with timing-safe comparison; single-use tokens; session revocation on password reset/change. | `docs/SECURITY_AND_TEST_REPORT.md` §3, §5; `tests/paystack-momo.test.ts`, `sms-status-webhook.test.ts`, `security.test.ts` |
| Tab sessions are independent per browser tab; a cached offline page without a valid prepared session fails closed. | `tests/tab-session-isolation.test.ts`, `e2e/tab-sessions.spec.ts`, `e2e/tab-session-failures.spec.ts`, `docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §4.1 |
| Privacy actions require an active `RiskPrivacyAccess` grant or an authenticated platform-owner session. | `docs/privacy/SUBJECT-RIGHTS-OPERATIONS.md:11`, `tests/risk-governance-actions.test.ts` |

---

## 3. Scenario catalogue by role

`Existing evidence` names a test that already exercises the rule. `GAP` means no test evidence
was found. `VERIFY` means a rule is known but the exact scenario needs a run on a clean tree.

### 3.1 Anonymous

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| AN-01 | Open `/`, `/features`, `/solutions`, `/about`, `/contact`, `/privacy`, `/terms` | Pages render; canonical metadata and no Render host in public HTML | `e2e/maacash-landing.spec.ts`, `tests/custom-domain.test.ts`, `tests/public-routes.test.ts`; public axe check in `scripts/check-accessibility.mjs` |
| AN-02 | Request a protected route with no session (`/admin/*`, `/worker/*`, `/customer/*`, `/platform/*`) | Redirect to the matching sign-in; no data in HTML | `tests/middleware-boundaries.test.ts`, `docs/security/external-pentest/03-...md:32–37` |
| AN-03 | Submit unknown email to forgot-password | Same generic confirmation as a known address | `e2e/maacash-auth-security.spec.ts:18` — passed in earlier browser run |
| AN-04 | Open reset / verification screens with no token | Ask for a new link / offer resend; no token accepted | `e2e/maacash-auth-security.spec.ts:28,34` |
| AN-05 | Submit stale or reused reset token | Rejected; sessions remain revoked | `tests/security.test.ts`, `tests/password-lockout-live.test.ts`; VERIFY end-to-end |
| AN-06 | Change `?role=` to an unlisted value | Value validated against allowed role enum before use; no reflected arbitrary content | `docs/security/dast/ZAP-BASELINE-2026-11.md` rule 10031; `tests/enquiry-turnstile.test.ts` |
| AN-07 | Low-bandwidth interruption while loading a public page | Layout stable; no spinner-driven shift; retry shows human error, not stack trace | GAP — no throttled public-page run |
| AN-08 | Submit public account enquiry with stale Turnstile token | Refused; no account data disclosed | `tests/turnstile-action-mapping.test.ts`, `tests/enquiry-turnstile.test.ts` |

### 3.2 Business admin (tenant administrator)

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| BA-01 | Sign in, see entitled MoMo and Susu modules, review worker days, export a report | Correct tenant data only; dashboard loads | `e2e/role-workflows.spec.ts:127`, `maacash-dual-role-switch.spec.ts`, `tests/consolidated-reporting.test.ts` |
| BA-02 | Submit an operations policy (shift/shared-device rules), reload | Saved values persist | Rule exists; **`e2e/maacash-policy.spec.ts:24` fails** — known gap, not a rule defect proven |
| BA-03 | Import a provider statement, auto-match one row, leave one unmatched; then manually match | Import summary shown; unmatched row retained; **no `provider_confirmed` claim** | Rule verified; **`e2e/maacash-reconciliation.spec.ts:45,84` fail** — known gap |
| BA-04 | Submit a short-branch liquidity day without explanation | Submit stays disabled; explanation of at least 10 characters required | Expectation asserted only by `e2e/maacash-reconciliation.spec.ts:129`, which **fails**; confirm the rule against the live UI before calling it a defect |
| BA-05 | View liquidity forecast for a branch with 0, 10 and 400 days of history | Zero with honest message; plain average; 180-day cap; integer pesewa; no transfer field | `tests/liquidity-forecast.test.ts`, `tests/liquidity-forecast-acceptance.test.ts` |
| BA-06 | Open another tenant's transaction / customer / staff id directly | 404 or "not found"; no cross-tenant fields | `tests/tenant-isolation.test.ts`, `tests/zeli-tenant-access.test.ts`, `e2e/zeli.spec.ts:93` |
| BA-07 | Open another branch's account or draft | Denied; branch id from session/assignment, not browser input | `tests/offline-momo-drafts.test.ts:296,484` |
| BA-08 | Process withdrawal: wrong re-auth password, then own password | Wrong password rejected; correct one completes; single-use grant | `tests/reauth.test.ts`; **`e2e/role-workflows.spec.ts:139` fails** — known gap |
| BA-09 | Double-click withdrawal submit / replay idempotency key | Exactly one withdrawal; replay denied | `tests/pg-withdrawal-concurrency.test.ts`, `tests/financial-security.test.ts` |
| BA-10 | Reverse a withdrawal or contribution with 9-char reason, then 10-char reason | 9 rejected; 10 accepted; original row kept; second reversal fails | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §6; `tests/financial-corrections.test.ts` |
| BA-11 | Export CSV containing a crafted formula or large dataset | CSV escaped; export bounded/paginated per existing implementation | `tests/csv-export.test.ts`; large-dataset bound **UNKNOWN** |
| BA-12 | Session expires mid-form, then submit | Fail closed; no write; entered data kept where the UI promises drafts | `tests/drafts.test.ts`, `tests/reauth.test.ts`; browser run **VERIFY** |
| BA-13 | Open two tabs with different admin sessions | Independent sessions; no cross-tab overwrite | `tests/tab-session-isolation.test.ts`, `e2e/tab-sessions.spec.ts` |
| BA-14 | Ask for a withdrawal above business-specific limit | **UNKNOWN** — no limits exist in code; do not invent a threshold | Mark as owner policy decision |

### 3.3 Worker / MoMo agent

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| WO-01 | Create, save, submit own daily account for own branch | Accepted; arithmetic and difference computed | `tests/momo.test.ts`, `e2e/momo-workflow.spec.ts` |
| WO-02 | Enter `10.005`, negative, zero, excessive, `NaN`, non-numeric | Rejected; no coercion to zero; no rounding | `docs/testing/COUNTER-COMPANION-ANDROID-ACCEPTANCE.md` §5, `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2 |
| WO-03 | Read back customer number before confirming capture; type a PIN-like value | Read-back enforced; `1234`/`pin`/`otp` refused, not stored | `tests/counter-companion.test.ts`, device sheet §3 |
| WO-04 | Capture offline with no connection, reconnect, sync | Draft stored; nothing posted; review/apply path only | `tests/offline-momo-drafts.test.ts`, `e2e/maacash-draft-persistence.spec.ts` |
| WO-05 | Re-send same capture with changed figures under same key | 409 payload mismatch, never overwrite | `tests/offline-momo-drafts.test.ts:259` |
| WO-06 | Capture older than 14 days; device authorised 25 h ago; revoked device | Stale marked for review; expired/revoked refused | `tests/offline-momo-drafts.test.ts:164,280`, `docs/product/offline-momo-operations.md` §3 |
| WO-07 | Apply capture to another worker's day, another branch, or an earlier save | Refused; online figures win | `tests/offline-momo-drafts.test.ts:391,484` |
| WO-08 | Lose connection mid-save with typed values | Values kept; in-place error shown, no redirect to login | Defect found and fixed; `docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §4.1; `e2e/maacash-evidence.spec.ts:60` re-run passed |
| WO-09 | Open worker dashboard on 360/390/768/1280 px and Pixel 7 | No horizontal overflow; labels visible | `e2e/responsive.spec.ts`, `e2e/mobile.spec.ts`, `maacash-evidence` (opt-in) |
| WO-10 | Attach supporting evidence, then view provenance | Level advances to `evidence_attached`; "no network integration confirmed" note remains | `tests/evidence-provenance.test.ts`, `tests/evidence-dispute-sla.test.ts` |
| WO-11 | Import statement match, then check confirmation level | `statement_matched`, never `provider_confirmed` | `tests/provider-statement.test.ts`, `docs/product/closed-loop-evidence.md` §3.1 |
| WO-12 | Two tabs, one with cleared session | Tab-scoped session; cleared tab fails closed, other keeps working | `e2e/tab-session-failures.spec.ts`, `tests/cross-tab-session.test.ts` |

### 3.4 Susu collector

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| CO-01 | Search assigned customer, record a 20.00 collection with prefilled amount | Contribution and allocation created; "1 day(s) covered" shown | `e2e/role-workflows.spec.ts:16` — passed in clean run, failed once in retry log |
| CO-02 | Record for unassigned customer or another tenant's customer | Denied; assignment rechecked server-side | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2; `tests/susu.test.ts`; browser case **GAP** |
| CO-03 | Pay 1.5× daily contribution or 0 days | Rejected; whole days 1–31 | `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2 |
| CO-04 | Submit same collection twice quickly | Unique `referenceId` / idempotency key prevents double credit | `tests/financial-security.test.ts`, `tests/susu.test.ts` |
| CO-05 | Offline collection sync from enrolled device, then revoke device and sync again | First accepted; revoked device refused | `tests/offline-requests.test.ts`, `docs/security/FINANCIAL-OPERATION-SECURITY.md` §2, §7.5 |
| CO-06 | Hand over cash with physical confirmation | Two-sided handover recorded; policy gate on daily close | `tests/shift-handover.test.ts`, `tests/employee-accountability.test.ts` |
| CO-07 | Large assigned-customer list and slow network | Paginated/bounded list; skeleton layout stable | `tests/customer-dashboard-mapping.test.ts`; collector-specific large list **GAP** |
| CO-08 | Invalid customer id in URL | 404; no other customer data | role matrix §36; explicit collector case **GAP** |

### 3.5 Customer

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| CU-01 | Sign in with phone / Account Number, open payments, statement, withdrawals, profile, settings | Own record only; "Contribution" label for deposits | `e2e/role-workflows.spec.ts:50` |
| CU-02 | Sign out: Escape dialog, then confirm | Escape keeps session; confirm reaches `/login?role=customer` | `e2e/role-workflows.spec.ts:94` |
| CU-03 | Request withdrawal where enabled; cancel; admin decides | Request lifecycle and audit; no self-posting of money | `tests/withdrawal-requests.test.ts`, `e2e/maacash-portal-withdrawals.spec.ts` |
| CU-04 | Open another customer's id / statement URL | Denied; own-record-only rule | role matrix §41; explicit browser case **GAP** |
| CU-05 | Try to reach staff or platform routes with customer session | Denied | `tests/middleware-boundaries.test.ts`, `tests/unified-login.test.ts` |
| CU-06 | Message consent: opt in without proof, confirm code, receive receipt | Proof required; consent and receipt events recorded | `tests/messaging-consent.test.ts`, `tests/customer-messaging.test.ts`, `tests/receipt-messaging.test.ts` |
| CU-07 | Open dispute with late evidence or out-of-SLA state | SLA/validation rules applied | `tests/evidence-dispute-sla.test.ts`, `tests/customer-disputes.test.ts` |
| CU-08 | Poor connection during statement load | Stable layout, human error on failure | GAP in browser; unit skeleton rules in `tests/ux-behaviours.test.ts` |

### 3.6 Platform admin

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| PA-01 | Sign in through `/platform/login`, view tenant directory and audit | Platform-only data; tenant cookie cannot open console | `tests/platform-auth.test.ts`, `e2e/platform.spec.ts` |
| PA-02 | Enroll, suspend or change status of a tenant | Authorised with reason; tenant-facing users cannot do it | `tests/enrollment.test.ts`, `tests/tenant-status-access.test.ts` |
| PA-03 | Grant/revoke Zeli entitlement and toggle global availability | Entitlement matrix enforced server-side; master switch OFF denies tenant use | `tests/zeli-availability.test.ts`, `tests/zeli-analytics-access.test.ts`, `e2e/platform.spec.ts` |
| PA-04 | Configure packages, reconcile payment, emergency stop; start checkout as platform admin | Role matrix §63–71: start checkout is tenant-admin only | `tests/zeli-commerce-actions.test.ts`, `tests/zeli-billing.test.ts` |
| PA-05 | Verify webhook with bad signature and replayed event | Rejected; no entitlement change | `tests/paystack-momo.test.ts`, `tests/zeli-billing.test.ts` |
| PA-06 | Revoke a central session while user is active | Session invalidated; user must re-authenticate | `tests/platform-session-revocation.test.ts`, `e2e/tab-sessions.spec.ts` |
| PA-07 | Grant `RiskPrivacyAccess` to an existing admin, then revoke | Grant active then inactive; no DPO appointment created | `tests/risk-governance-actions.test.ts`, `src/lib/actions/risk-organisation.actions.ts` |
| PA-08 | Full history secret scan and CodeQL SARIF review on a release branch | No secret material in reports; findings dispositioned | CI jobs observed; SARIF content **UNKNOWN** |

### 3.7 Privacy grant holder (`privacy_admin` / `privacy_reviewer`)

| ID | Scenario | Expected outcome | Existing evidence / status |
| --- | --- | --- | --- |
| PH-01 | Active grant holder opens privacy review and handles a subject rights request | Allowed; every action rechecks active grant | `tests/risk-governance-actions.test.ts`, `tests/risk-notification-onboarding.test.ts` |
| PH-02 | Grant revoked mid-session, then submit a rights action | Denied; no data returned | Rule in `docs/privacy/SUBJECT-RIGHTS-OPERATIONS.md:11`; browser case **GAP** |
| PH-03 | Tenant admin with no grant attempts privacy action | Denied (unless platform owner) | `tests/risk-governance-actions.test.ts` |
| PH-04 | Countersign / publish notice without required countersignature | Refused; audit event written | `tests/risk-governance-actions.test.ts`, `tests/legal-instruments.test.ts` |
| PH-05 | Notification delivered to a subject; inspect stored delivery record | Only hash of address stored; no subject identity or document content | `tests/risk-notification-onboarding.test.ts`, schema `GovernanceDocumentDelivery` |
| PH-06 | Query shared risk intelligence with 2 contributors, then 3 businesses / category agreement | No disclosure, then banded prompt only; no name, note or contributor id | `docs/product/shared-agent-risk-intelligence.md` §3; `tests/risk-intelligence-acceptance.test.ts` |
| PH-07 | Query with missing salt / stale policy version | Hard failure / must re-accept; no silent collection | same; `tests/risk-intelligence.test.ts` |
| PH-08 | Signal older than 180 days in cohort | Excluded; marked expired, row retained | same; `tests/risk-intelligence.test.ts` |
| PH-09 | Subject challenges a signal | **UNKNOWN** — no cross-business dispute route exists; recorded governance gap, not a test to invent | `docs/testing/LOCAL-FINAL-ACCEPTANCE-REPORT.md` §4.3 |

---

## 4. Cross-cutting real-world conditions

| Condition | Current evidence | Gap / action |
| --- | --- | --- |
| **Stale sessions** | `tests/reauth.test.ts`, `security.test.ts`, `platform-session-revocation.test.ts`, `tests/cross-tab-session.test.ts`; fixed offline-guard defect in acceptance report §4.1 | Add a browser journey: leave form open past expiry, submit, confirm no write and data preserved |
| **Duplicate submissions / double-click** | `financial-security.test.ts`, `pg-offline-idempotency.test.ts`, `pg-withdrawal-concurrency.test.ts`, `payment-intent-attempts.test.ts` | Add UI double-click on withdrawal and collection in E2E; assert one row |
| **Concurrency** | PG advisory-lock test for two withdrawals; commission conditional claim | No concurrent cross-user/cross-branch write test on SQLite or PG; no concurrent entitlement grant test |
| **Cross-tenant / cross-branch** | `tenant-isolation.test.ts`, `zeli-tenant-access.test.ts`, `offline-momo-drafts.test.ts:296,484`, `e2e/zeli.spec.ts:93` | Add direct-API IDOR table across every role and object id documented in role matrix §32–42 |
| **Invalid ids** | 404-on-foreign-id is a documented expectation; covered for some actions | Enumerate every `[id]` route and assert 404, not 403-with-data or 200 |
| **Low-bandwidth interruption** | Offline status and fail-closed E2E (`maacash-offline-status`, `tab-session-failures`), offline guard fix | No throttled/partial-response browser scenario; add controlled network shaping in isolated env |
| **Provider timeout / malformed response** | `zeli-provider-resilience.test.ts`, `paystack-ping.test.ts`, `sms-status-webhook.test.ts`, `tests/provider-statement.test.ts` parsing tests | No live-equivalent timeout with concurrent retries; no shared measurement of provider latency |
| **Duplicate / out-of-order webhooks** | HMAC and single-use token tests; Zeli billing lifecycle includes webhook lifecycle | Add explicit duplicate and out-of-order callback sequence assertions for each provider with a synthetic event log |
| **Background retries** | Offline queue, retention sweep, Zeli expiry scheduler tests | No multi-instance overlap/restart-during-sweep test; single-instance plan currently limits risk |
| **Large datasets** | 180-day forecast cap, pagination in some actions, 400-day history test | No defined dataset-size ceiling for reports/exports/analytics; **UNKNOWN** — set with owner before testing |
| **Exports** | `csv-export.test.ts`, role-scoped export route in role matrix §29 | Add E2E export by worker vs admin vs collector and assert row scope; large-export limit **UNKNOWN** |
| **User mistakes** | `10.005`, PIN-like input, wrong re-auth password, Escape on sign-out, invalid phone formats all covered | Add "wrong role card", "wrong tenant link", "stale prefilled amount" browser journeys |

---

## 5. Outstanding unknowns (must not be guessed)

1. Business-specific withdrawal limits, dual-approval thresholds and daily caps — none exist
   (`docs/security/FINANCIAL-OPERATION-SECURITY.md` §7.3).
2. Dataset-size ceilings for exports, reports and analytics.
3. Multi-instance behaviour of retention and expiry sweeps; current plan is one instance.
4. Subject challenge route for shared risk signals — governance gap, not implemented.
5. Provider-confirmed transactions — impossible by design until an approved integration exists.
6. Physical-device / SIM-specific behaviour and IndexedDB persistence across a browser restart —
   owner manual test (`docs/testing/COUNTER-COMPANION-ANDROID-ACCEPTANCE.md` §6).
7. Six production-host browser checks — require a deployed, owner-authorised origin.

Scenarios marked GAP are proposals, not claimed failures. Scenarios marked UNKNOWN require a
product or policy decision before they can become testable expectations.
