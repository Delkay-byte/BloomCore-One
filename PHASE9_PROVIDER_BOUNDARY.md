# Phase 9 — HCode and Hubtel release boundary

**Status:** boundary statement for the Phase 1–9 verification branch. **Neither HCode nor Hubtel is integrated.** This document records what that means for a release decision, so no reader mistakes a future integration assessment for delivered functionality.

**Branch:** `feat/susu-enterprise-phases-1-9-verification`
**Baseline for phases 1–8:** `39a23d0` (Phase 8 merge)
**Review date:** 2026-11-27

---

## 1. The boundary in one paragraph

MaaCash Susu owns its own tenant, branch, staff, customer, cycle, contribution, remittance, withdrawal, reconciliation and support data, and it owns every authorisation decision over that data. HCode is an external legacy system from which a business may want to migrate identities; Hubtel is an external payment/messaging provider. Neither system is a runtime dependency of this repository. There is no HCode or Hubtel code, credential, endpoint, webhook, scheduled job or test in the tree. A deployment that does not configure either provider is a complete deployment of Phases 1–9 as verified here.

---

## 2. HCode

### Current state

- `rg -i hcode` over the tree returns only language/runtime false positives (`hashCode`, `is-fullwidth-code-point`); no import schema, API client, database link, configuration key or sample export exists.
- The only supported legacy path is the Phase 7 **CSV import**: a reviewed, idempotent identity import that creates customers and accounts and **refuses to invent historic money**. It does not read HCode directly.
- The Phase 1–7 integration report already classed HCode compatibility as **paper-only**.

### What a business can do today

| Need | Supported? | Mechanism |
|---|---|---|
| Bring customer names, phones, e-mail, external references | Yes | Phase 7 CSV import with a dry-run and row-level review |
| Bring account numbers, daily contribution, branch, collector reference | Yes, when the row is unambiguous | Phase 7 import; unresolved branches/collectors become review rows |
| Bring historic contributions, balances or commission | **No** | Import refuses to fabricate history; a cut-over must start from a confirmed opening position or replay |
| Live HCode database or API feed | **No** | No connector exists |
| Automatic HCode reconciliation | **No** | Would need a field-confirmation exercise and a count reconciliation first |

### Boundary rule

HCode is a **data source for a one-off migration**, not a system of record after cut-over. After import, MaaCash is authoritative. No HCode user, password, token or endpoint may be stored in this repository. Any future connector requires a separate, approved design that reuses the Phase 7 import idempotency and review model rather than writing directly into financial tables.

---

## 3. Hubtel

### Current state

- The repository contains **no Hubtel code, configuration, secret, URL or test**.
- Susu money movement is manual and evidence-backed:
  - cash in through `recordContribution` with a unique reference and a branch;
  - cash out through the Phase 4 approval/step-up gate and recorded payment evidence;
  - collector settlement through Phase 3 declare → receive → verify;
  - reconciliation through Phase 5 sessions and exception cases.
- The only live payment-provider code is Paystack for **platform billing** (Zeli subscription), not tenant Susu cash.
- Outbound messaging has a provider seam (`MessageProvider`) with only a mock adapter.

### What is deliberately not delivered

| Hubtel capability | Status | Why it is outside this release |
|---|---|---|
| Collection webhook (customer pays into Susu) | Not implemented | Needs a provider-agnostic collection adapter, raw-body signature verification, tenant/account resolution and idempotency |
| Payout execution | Not implemented | The current state machine records a payout; it has no "paying" recovery state and no provider call |
| Settlement/statement feed | Not implemented | Phase 5 sessions are manual; line ingestion and matching rules do not exist |
| Provider fee accounting | Not implemented | No field exists; posting a fee as commission would corrupt reporting |
| SMS receipts/OTP | Not implemented | Only the mock provider seam exists |

### Boundary rule

Hubtel is **not a dependency of this release**. A deployment must not claim Hubtel collections, payouts or SMS. Any future integration must:

1. verify the raw request body with the provider's signature before parsing (the Paystack webhook is the pattern);
2. treat the provider transaction id as the idempotency key, not a new random reference per retry;
3. convert pesewas to GHS exactly once at the boundary (Phase 4 thresholds are integer pesewas; `Contribution.amount` is Decimal GHS);
4. never post a provider fee as business commission;
5. add a recoverable payout state before any outbound money call;
6. keep credentials in the deployment secret store, never in the repository, tests or logs.

---

## 4. Release-decision consequences

- The readiness decision for Phases 1–9 **must not depend on** HCode or Hubtel being connected. They are business/infrastructure decisions outside the code verified here.
- A pilot can run on the manual, evidence-backed Susu flows exactly as tested. A business that requires automated Hubtel collection or payout is **not ready for that workflow** and must not be told otherwise.
- The release checklist separates:
  - code verified locally;
  - business validation (HCode field mapping, cut-over counts, provider contract);
  - infrastructure-provider configuration (Hubtel credentials, webhook URL, IP allow-list);
  - owner authorisation (connect a provider, move real money).
- If an owner later authorises Hubtel, that work starts from `HUBTEL_INTEGRATION_ASSESSMENT.md` and requires its own security review; it is **not** a configuration toggle in this branch.

---

## 5. Evidence

- `HUBTEL_INTEGRATION_ASSESSMENT.md` — field mapping, ranked gaps, security requirements, verdict.
- `PHASES_1_7_INTEGRATION_REPORT.md` sections 17–18 — HCode and Hubtel findings.
- `PHASE7_INTEGRATION_CONTRACT.md` — the import boundary that any HCode cut-over must honour.
- `scripts/pg-safety.mjs` and the provider code paths named above were read during this review; no provider was contacted.

No HCode or Hubtel account, credential, sandbox call, webhook or production setting was created, read or changed for this document.
