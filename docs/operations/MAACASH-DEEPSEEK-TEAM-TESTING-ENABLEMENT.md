# MaaCash — DeepSeek Team Testing Enablement

**Date:** 2026-11-07
**Service:** `maacash` — `srv-dbnaciff3r2c7382tjgg`
**URL:** https://maacash.onrender.com
**Branch:** `main`
**Deployed commit:** `2cf1dcd24392f5ee5411ced836d1c18fdf903765`
**Deployment:** `dep-dbnjh80u01pc73cuhqv0`

---

## 1. Final architecture

Team Testing is a separate external-AI mode. It is not approved production
processing and it does not use the business-tool orchestration path.

Request path:

1. `src/app/zeli/page.tsx` sends a message to `POST /api/zeli/chat`.
2. `runZeliTurn` resolves the authenticated `ZeliIdentity` from the tab session.
3. `getConversationPolicy(tenantId, userId)` evaluates the global control in
   `ZeliProviderControl` and the restricted tester row in `ZeliTeamTester`.
4. Team Testing is allowed only when all of these are true:
   - reviewed code constant `TEAM_TESTING_APPROVED`;
   - `ZELI_TEAM_TESTING_ALLOWED=true` on the service;
   - global control mode is `team_testing`;
   - controlled disclosure version `2026-11-team.1` is recorded;
   - tenant code is `BIK-HQ-001`;
   - the tenant is authorized;
   - the user has an active `ZeliTeamTester` grant;
   - that user accepted the disclosure;
   - the emergency stop is cleared;
   - the DeepSeek credential is present.
5. The Team Testing path calls `requestDeepSeekTeamConversation`, which sends a
   fixed fictional scenario, the sanitised message and bounded conversation
   history to `https://api.deepseek.com/chat/completions`.
6. The requested model is `deepseek-flash`, with DeepSeek thinking disabled so
   the response uses assistant content rather than reasoning-only output.
7. The response is validated and labelled
   `[TEAM TESTING · LIVE DEEPSEEK API · SYNTHETIC BUSINESS DATA]`.
8. Provider usage and platform/tenant audit rows are written. Prompts,
   responses, credentials and raw identifiers are not stored in the usage ledger.

The existing `deepseek-chat` tool-orchestration path is not used in Team Testing.
It is reserved for the separately approved aggregate-production path.

---

## 2. Data restrictions

Team Testing uses a fixed fictional scenario:

- Demo Enterprise (fictional)
- East Demo and West Demo branches
- Ama Demo and Kojo Sample as fictional customers
- a fictional daily contribution example

Before a message or history entry leaves MaaCash:

- URLs, emails, phone numbers, references and digits are sanitised;
- known customer names, customer IDs, customer phone numbers, customer emails,
  staff names, staff emails and staff phone numbers for the tenant are replaced
  locally with `[redacted identifier]`;
- no tenant records are passed to the model;
- no tool orchestration is called;
- no live customer, balance, transaction, withdrawal, remittance or employee
  record is sent.

The UI displays a prominent synthetic-data warning and requires explicit
disclosure acceptance before the first external conversation.

---

## 3. Environment configuration

Configured on `maacash` only:

| Variable | Value |
| --- | --- |
| `ZELI_TEAM_TESTING_ALLOWED` | `true` |
| `ZELI_TEAM_TESTING_TENANT_CODE` | `BIK-HQ-001` |
| `ZELI_EXPIRY_SCHEDULER` | `disabled` |
| `DEEPSEEK_MODEL` | `deepseek-flash` (existing) |
| `DEEPSEEK_API_KEY` | present; value not recorded |
| `ZELI_SYNTHETIC_TESTING_ALLOWED` | `false` (unchanged) |

`bloomcore-one` was not given team-testing permission and was not redeployed.

---

## 4. Platform control centre

`src/app/platform/(console)/zeli/ZeliAdminControlCentre.tsx` now separates:

- **A — Global Zeli Availability**: ON/OFF, last change, reason, mandatory reason,
  enable/disable buttons. It never implies DeepSeek is enabled.
- **B — AI Operating Mode**: radio cards for Disabled, Synthetic testing, Team
  Testing and Approved Production, with data explanations and disabled reasons.
  It includes audited Apply, Emergency stop and Clear emergency stop controls.
- **C — DeepSeek Provider Status**: credential, model, connectivity, emergency
  stop, last success/failure, request counts, and a real **Test DeepSeek
  Connection** action. The probe sends a harmless fixed prompt and is labelled as
  connectivity-only, not proof of conversation routing.
- **D — Safety and Approval Gates**: readable status rows for code approval,
  environment permission, disclosure version, tenant, authorization, tester
  access and emergency stop; approved-production gates are collapsible.
- **E — Tenant and Team Access**: restricted tenant, team members, active/revoked
  status, disclosure acceptance, and audited grant/revoke actions with reasons.
- **F — Usage and Audit**: total/24h requests, successes, failures, denied
  requests, last success/failure/request, model, and a link to platform audit.
  Prompt/response storage is explicitly marked “Never stored”.

Status labels are not buttons. Only real actions are interactive.

---

## 5. Activation evidence

Performed through the audited platform controls by the platform operator:

| Action | Evidence |
| --- | --- |
| Restricted team tenant | `BIK-HQ-001` authorized |
| Tenant authorization | existing authorization retained |
| Tester grant | BIK-HQ-001 administrator granted, audited `zeli.team_tester_granted` |
| Tester disclosure | version `2026-11-team.1` accepted; tenant audit `zeli.team_disclosure_accepted` |
| Emergency stop clear | reason: “Enable restricted MaaCash team testing with live DeepSeek API and synthetic business data.” |
| Team Testing mode | enabled; control mode `team_testing`; policy version `2026-11-team.1` |
| Approved Production | still locked; code constant remains false |
| Emergency stop | cleared at final state |
| DeepSeek connectivity | test passed, ~1.2 s, model `deepseek-flash`, input 26 / output 1 tokens |

Final control state:

- `mode=team_testing`
- `enabled=true`
- `emergencyDisabled=false`
- `policyVersion=2026-11-team.1`
- active tester: BIK-HQ-001 administrator
- disclosure accepted: yes

---

## 6. Live acceptance

Real conversations were run through the MaaCash chat endpoint and UI after
activation. The UI displayed **TEAM TESTING — LIVE DEEPSEEK API** and the
`Team Testing · live DeepSeek` badge.

Successful requests recorded in `ZeliProviderUsage`:

| Time (UTC) | Decision | Model | Latency | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- |
| 14:30:23 | success | deepseek-flash | 1,599 ms | 627 | 90 |
| 14:44:43 | success | deepseek-flash | 915 ms | 774 | 57 |
| 14:45:11 | success | deepseek-flash | 1,101 ms | 672 | 34 |
| 14:45:37 | success | deepseek-flash | 885 ms | 606 | 72 |

The last three were through the chat UI, including a follow-up in the same
conversation (“What did you just say the two branches were?”). The assistant
correctly continued the fictional context: “I said the two fictional branches
are East Demo and West Demo.” A further turn summarised the synthetic scenario.
No deterministic substitution occurred.

Emergency-stop acceptance:

- emergency stop activated through the platform control;
- `/api/zeli/chat` then returned `x-zeli-external-ai: disabled`,
  `x-zeli-external-ai-allowed: false`, `x-zeli-conversation-mode: local`;
- no provider success was recorded for the stopped request;
- the stop was then cleared with the required reason and Team Testing restored.

The platform session was re-established by the owner when deployment restarted
the platform session; the owner also completed the BIK-HQ-001 admin login and
MFA. No credentials or MFA codes were shared with the agent.

---

## 7. Tests and quality gates

| Gate | Result |
| --- | --- |
| `npm test` | **62 files, 633 tests, 0 failed** |
| Team-testing targeted tests | **10 passed** |
| Provider/action/control targeted tests | **42 passed** |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| GitHub CI on deployment commit | Pass |
| PostgreSQL table migration | Additive `ZeliTeamTester` table only |

Added tests cover:

- genuine provider invocation and multi-turn continuity;
- successful and failed provider responses;
- missing credential;
- emergency stop and disabled-mode denial;
- restricted tenant/tester access and disclosure acceptance;
- local redaction of real customer identifiers;
- no deterministic substitution on provider failure;
- approved production remaining locked;
- audited tester grant/revoke.

---

## 8. Deployment

| Item | Value |
| --- | --- |
| Service | `maacash` — `srv-dbnaciff3r2c7382tjgg` |
| Commit | `2cf1dcd24392f5ee5411ced836d1c18fdf903765` |
| Deployment ID | `dep-dbnjh80u01pc73cuhqv0` |
| Status | live |
| Health | 200 |
| Readiness | 200, database healthy |
| Auto-Deploy | OFF (explicit deploy) |
| Existing `bloomcore-one` | untouched at `ea869a9…` |

Database change was additive only:

`CREATE TABLE IF NOT EXISTS "ZeliTeamTester"` with its unique and lookup indexes.
No existing table, column, record, entitlement, subscription or financial row was
altered.

The new service keeps `ZELI_EXPIRY_SCHEDULER=disabled`; the existing
`bloomcore-one` service remains the single Zeli expiry scheduler.

---

## 9. Remaining limitations

1. **Fresh Zeli page can show the disclosure acceptance prompt again** even
   though the acceptance is recorded. Clicking “Accept disclosure” is idempotent
   and immediately enables the input; the platform control centre shows the
   correct accepted timestamp. This is a UI-cache/refresh limitation, not an
   authorization bypass: the server still enforces the recorded acceptance.
2. **Team Testing uses synthetic data only.** It cannot answer live financial or
   customer-record questions; those remain local MaaCash answers.
3. **Approved Production remains locked.** Its code approval, privacy version,
   approval reference and production tenant authorization are separate gates and
   were not changed.
4. **No real Paystack, financial or customer-data operation was performed** during
   this task.

---

## 10. Final status

### DEEPSEEK TEAM TESTING LIVE — REAL API CONVERSATIONS VERIFIED

- **Public URL:** https://maacash.onrender.com
- **Final deployed SHA:** `2cf1dcd24392f5ee5411ced836d1c18fdf903765`
- **Render deployment:** `dep-dbnjh80u01pc73cuhqv0`
- **Mode:** Team Testing, `deepseek-flash`, synthetic business data only
- **Emergency stop:** cleared after the stop test; Team Testing restored
- **Approved Production:** still locked
- **Existing service:** `bloomcore-one` unchanged and live
