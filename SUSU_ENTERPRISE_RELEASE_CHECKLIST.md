# MaaCash Susu Enterprise — Release Checklist (Phases 1–9)

**Branch:** `feat/susu-enterprise-phases-1-9-verification`
**Verification report:** `PHASE9_FINAL_VERIFICATION_REPORT.md`
**Readiness decision:** B — TECHNICALLY READY FOR CONTROLLED PILOT
**Date:** 2026-11-27

This checklist separates what is finished from what is merely planned. An item is never moved between categories because it is inconvenient. "Verified by automated tests" means a command in this repository exercises the behaviour and would fail if the guard were removed.

---

## 1. Completed locally (code and documentation)

| # | Item | Where |
|---|---|---|
| 1.1 | Verification worktree and branch created from `8a98782` | `feat/susu-enterprise-phases-1-9-verification` |
| 1.2 | Phase 8 merged with `--no-ff`, no conflicts | merge `39a23d0` |
| 1.3 | Phases 1–8 reviewed against code, tests and contracts | report sections 5–12 |
| 1.4 | Branch-limited staff-administration gap fixed | staff page, lifecycle actions, regression test |
| 1.5 | Release-verifier migration cut-off corrected | `scripts/verify-pg-migrations.mjs` |
| 1.6 | PostgreSQL hook-timeout root-caused and test environment fixed | `docs/testing/POSTGRES-TEST-ENVIRONMENT.md` |
| 1.7 | Fresh PG16 and disposable PG18 rehearsals | report section 15 |
| 1.8 | Scenarios A–I executed and mapped to evidence | report section 18 |
| 1.9 | Security matrix completed | report section 13 |
| 1.10 | Performance review completed (no load test) | report section 19 |
| 1.11 | HCode/Hubtel boundary documented | `PHASE9_PROVIDER_BOUNDARY.md` |
| 1.12 | Final verification report written | `PHASE9_FINAL_VERIFICATION_REPORT.md` |
| 1.13 | Phase 9 changes committed on the verification branch | Phase 9 fix commit at the branch tip |
| 1.14 | No production action taken | report section 20.4 |

---

## 2. Verified by automated tests

Run on the final tree; exact numbers and durations are in report section 16.

| # | Claim | Command | Result |
|---|---|---|---|
| 2.1 | Both Prisma schemas are valid | `npx prisma validate` | pass |
| 2.2 | 78 migrations apply to a fresh PostgreSQL 16 database | `prisma migrate deploy` + `status` + `diff` | pass |
| 2.3 | The same chain applies to PostgreSQL 18 | disposable PG18 rehearsal | pass |
| 2.4 | Existing data survives an additive upgrade; interrupted migration recovers | `node scripts/verify-pg-migrations.mjs` | pass |
| 2.5 | SQLite behaviour, 181 files | `npm test` | 2,073 passed |
| 2.6 | PostgreSQL behaviour, 15 files | `npm run test:pg` | 61 passed, 3× |
| 2.7 | TypeScript strict | `npm run typecheck` | exit 0 |
| 2.8 | Lint has no errors | `npm run lint` | 0 errors / 193 warnings |
| 2.9 | Production build | `npm run build` (inside the gate) | PASS, 282 s |
| 2.10 | Browser journeys (support, staff, guide, platform queue) | `npx playwright test e2e/maacash-support.spec.ts` | 4 passed |
| 2.11 | Full browser suite | `npm run test:e2e` (inside the gate) | 129 passed, 8.9 min |
| 2.12 | All release gates in one command | `npm run test:release` | PASS on the final tree |
| 2.13 | Tenant isolation, branch scope and role guards | unit + PG suites | pass |
| 2.14 | Financial idempotency and concurrency | PG suites | pass |
| 2.15 | CSV formula neutralisation | `tests/csv-export.test.ts` | pass |
| 2.16 | Support internal notes are invisible to tenants | `tests/susu-support-tenant.test.ts` | pass |
| 2.17 | Branch manager cannot administer staff | `tests/susu-staff-lifecycle.test.ts` | pass |
| 2.18 | Export writes an audit row | `tests/susu-guide-and-export.test.ts`, `tests/susu-reporting.test.ts` | pass |

---

## 3. Requires business validation

These are not code defects. They need a named business owner to decide, confirm or sign off.

| # | Item | Owner | Why it cannot be closed by code |
|---|---|---|---|
| 3.1 | HCode field mapping and source-of-truth confirmation | Business + migration lead | The repository cannot know what each HCode column means |
| 3.2 | HCode duplicate/merged-customer counts | Business + migration lead | Requires a read-only extract and reconciliation |
| 3.3 | Opening position for cut-over (or a decision to start from zero) | Business + finance | Historic money must not be fabricated |
| 3.4 | Support operating model: named agents, rota, escalation ownership, response targets | Operations | The queue exists; staffing and SLAs are decisions |
| 3.5 | Which support categories are tenant-visible vs internal | Operations + compliance | Policy, not schema |
| 3.6 | Withdrawal policy values (limits, high-value threshold, approvals) per tenant | Business + finance | Defaults are examples, not approvals |
| 3.7 | Report definitions and cycle dates used for pilot reporting | Finance | Must match how the business counts a cycle |
| 3.8 | Staff role mapping (who is company-wide, who is branch-limited) | Business | The code enforces the mapping it is given |
| 3.9 | Pilot success measures and exit criteria | Owner | Not technical |
| 3.10 | Whether the pilot handles cash only or also provider money | Owner + finance | Determines whether Hubtel work is in scope |
| 3.11 | Data protection review for the pilot's actual data | Business + counsel | The release does not assert a DPIA outcome |
| 3.12 | Customer communication for the pilot | Operations | Not a code artifact |

---

## 4. Requires infrastructure-provider configuration

| # | Item | Required setting / action | Status |
|---|---|---|---|
| 4.1 | Production PostgreSQL | Managed instance, `fsync=on`, `synchronous_commit=on`, connection pooling, backups | Not configured |
| 4.2 | Database credentials | Secret store, least-privilege role, rotation | Not configured |
| 4.3 | Application secrets | Session signing key, encryption keys, webhook secret | Not configured |
| 4.4 | Hosting | Deployment target, health checks, TLS, domain | Not configured |
| 4.5 | Monitoring and alerting | Error tracking, DB saturation, failed jobs, queue age | Not configured |
| 4.6 | Log retention | Central logs with PII minimisation | Not configured |
| 4.7 | Backup and restore rehearsal | Restore into a disposable environment and verify | Not performed |
| 4.8 | Email/SMS delivery | A real provider if customer messaging is enabled | Only a mock adapter exists |
| 4.9 | Paystack | Live keys only if platform billing is in scope; webhook URL and signature secret | Not configured for this release |
| 4.10 | Hubtel | Credentials, IP allow-list, webhook URL, commercial agreement | Not requested, not configured |
| 4.11 | HCode access | Read-only extract with a defined field contract | Not requested |
| 4.12 | Time synchronisation | NTP on app and database hosts (step-up TTL and audit ordering depend on it) | Not verified in any environment |
| 4.13 | PostgreSQL test/CI service | Disposable PG with `fsync=off` or tmpfs to avoid the I/O stall | Documented, not provisioned |
| 4.14 | Rate-limit backing store | Shared store if more than one app instance | Not configured |

No provider was contacted, and no credential was created or read, during Phase 9.

---

## 5. Requires owner authorisation

Nothing in this section may be inferred from a passing test.

| # | Action | Why authorisation is required |
|---|---|---|
| 5.1 | Merge the verification branch into `main` | Release control; explicitly prohibited in this phase |
| 5.2 | Push the branch or open a pull request | Explicitly prohibited in this phase |
| 5.3 | Deploy to any environment | Explicitly prohibited in this phase |
| 5.4 | Run a production migration | Explicitly prohibited in this phase |
| 5.5 | Connect Hubtel or any payment provider | Money movement and external contract |
| 5.6 | Connect HCode or import real customer data | Personal data and cut-over risk |
| 5.7 | Enable live Paystack transactions | Real charges |
| 5.8 | Start a controlled pilot with real tenants | The decision this checklist informs |
| 5.9 | Approve the pilot's data set and retention | Privacy and contractual |
| 5.10 | Approve support agents' access to tenant data | Access control ownership |
| 5.11 | Schedule the 1,000-VU load test | Explicitly excluded from this phase |
| 5.12 | Approve broad production (decision C) | Requires all of sections 3–4 closed |

---

## 6. Not implemented (do not claim otherwise)

| # | Capability | Current state | Consequence |
|---|---|---|---|
| 6.1 | HCode live connector / API sync | Not implemented | Cut-over is CSV only |
| 6.2 | Historic balances, contributions or commission import | Deliberately refused | A cut-over starts from a confirmed position, not invented history |
| 6.3 | Hubtel collection webhook | Not implemented | No automatic customer-to-Susu collection |
| 6.4 | Hubtel payout execution | Not implemented | Payout is recorded, not sent |
| 6.5 | Provider settlement/statement ingestion | Not implemented | Reconciliation remains manual |
| 6.6 | Provider fee accounting | Not implemented | Fees must not be posted as commission |
| 6.7 | Real SMS/email delivery | Mock provider only | No customer messaging in a pilot unless configured separately |
| 6.8 | Automated dunning / retries for billing | Not part of Phases 1–9 | Out of scope |
| 6.9 | Mobile apps | Not part of Phases 1–9 | Web only |
| 6.10 | Multi-currency | Not implemented | GHS only; pesewa/GHS conversion is a boundary rule |
| 6.11 | 1,000-VU capacity proof | Not performed | Capacity is a pilot assumption, not a tested claim |
| 6.12 | Platform action browser automation | Server-action tests only | Quality gap before broad production |
| 6.13 | Rate-limit ceiling tests | Not written | Ceilings are wired but not driven to the limit |
| 6.14 | Staff creation re-verification | Inherited flow, linked from the board | Not re-proved in Phase 9 |
| 6.15 | Automatic HCode reconciliation | Not implemented | Requires a field contract first |

---

## 7. Pilot go/no-go checklist

A controlled pilot may start only when every line is true.

- [ ] Sections 2.1–2.12 are green on the exact commit being released.
- [ ] Section 3 items that apply to the pilot are signed off by a named owner.
- [ ] Section 4.1–4.7 and 4.12–4.13 are configured and smoke-tested.
- [ ] Section 5.8–5.10 are authorised in writing.
- [ ] No item in section 6 is being represented to a pilot tenant as available.
- [ ] Support agents are named and know the escalation path.
- [ ] The pilot tenant knows the system records cash; it does not move money through Hubtel.
- [ ] A rollback/restore rehearsal has been performed on a disposable copy.
- [ ] The owner has accepted decision B, not C, as the scope of this release.

**Current status: NOT YET GO.** The local engineering gates are green (`test:release` PASSED on the final tree), but business validation, infrastructure configuration and owner authorisation are outstanding by design.

---

## 8. Sign-off record

| Role | Name | Decision | Date |
|---|---|---|---|
| Engineering (local verification) | — | B — technically ready for controlled pilot | 2026-11-27 |
| Business owner | — | Pending | — |
| Operations/support lead | — | Pending | — |
| Infrastructure owner | — | Pending | — |
| Security/privacy reviewer | — | Pending | — |

No signature above represents a production deployment or a provider connection.
