# Zeli — Enhanced AI Real-Provider Evidence

**Environment:** `bloomcore-one-staging`
**Date:** 4 November 2026
**Status:** **VERIFIED — real DeepSeek conversation succeeded.**

This file records metadata only. It never contains message content, business
figures, customer data or credentials.

## Method

The deployed staging application exposes a temporary acceptance probe:

`POST /api/zeli/acceptance/probe`

Guards: `APP_ENV=STAGING`, `ZELI_ACCEPTANCE_PROBE=enabled`, a 32+ byte token,
a fixed synthetic tenant (`STG-A`) and two fixed questions. It returns metadata
only.

The probe runs on the deployed server, against the staging PostgreSQL database,
using the DeepSeek credential already configured in staging.

| Turn | Question | Purpose |
|---|---|---|
| 1 | "Hello. What can you help me with?" | natural conversation, no tools |
| 2 | "Give me a summary of the business this month." | business tool + explanation |
| 3 | "What about last month?" | bounded follow-up context |

## Deployment

| Item | Value |
|---|---|
| Staging service | `bloomcore-one-staging` |
| Code SHA | `53391c0c5b58008e5a8047d191fbf565c7fb781b` (probe build; merged into `main` after verification) |
| Deploy status | live |
| Environment | `APP_ENV=STAGING` |
| Provider control | `synthetic`, enabled, emergency stop off |
| Credential configured | true (boolean check only) |
| Model | `deepseek-flash` |

## Result — 4 November 2026, 18:59 UTC

| Turn | Mode | Provider | Model | Tool | Context used | Numeric integrity | Latency | Tokens |
|---|---|---|---|---|---|---|---|---|
| 1 | external | `deepseek-conversation` | `deepseek-flash` | none | false | n/a (no figures) | 2,231 ms | 217 in / 199 out |
| 2 | external | `deepseek-enhanced` | `deepseek-flash` | `business_summary`, `exceptions` | false | verified | 10,309 ms | 5,593 in / 459 out |
| 3 | external | `deepseek-enhanced` | `deepseek-flash` | `period_comparison` | true | verified | 3,996 ms | 5,391 in / 368 out |

Provider audit rows (three):

```
provider:  deepseek
model:     deepseek-flash
purpose:   conversation:help
decision:  success
latency:   2231 ms
tokens:    217 / 199

provider:  deepseek
model:     deepseek-flash
purpose:   chat:business_summary,exceptions
decision:  success
latency:   10309 ms
tokens:    5593 / 459

provider:  deepseek
model:     deepseek-flash
purpose:   chat:period_comparison
decision:  success
latency:   3996 ms
tokens:    5391 / 368
```

A scan of the audit ledger for prompt text found **0** rows containing message
content. The ledger stores decisions, categories, latency and token counts only.

## What this proves

- The request reached the fixed DeepSeek endpoint.
- Authentication succeeded with the existing rotated credential.
- The configured allow-listed model responded.
- A natural greeting was answered by the external conversational path.
- The model selected approved read-only tools.
- The server executed the tools against the staging database.
- The model explained the tool results.
- Every numeric token in the business answers matched a tool result.
- Follow-up context was inherited from the previous turn.
- The staging audit recorded success without prompt content.
- No production data was available to the staging process.

## Earlier failures and resolution

| Time | Finding |
|---|---|
| 18:11 UTC | `provider_status_401:authentication_error` — staging held a stale credential |
| 18:45 UTC | First success; follow-up rejected because a legitimate derived change (1,200.00) was not in the facts |
| 18:50 UTC | Follow-up rejected because a list marker ("1.") was treated as a figure |
| 18:55 UTC | Follow-up rejected because the model introduced an ungrounded count |
| 18:59 UTC | Both turns succeed after explicit change facts, list-marker handling and stricter model instructions |

The stale staging value was replaced with the owner's existing rotated
credential through the Render environment API. The value was never displayed,
logged, written to disk, committed or returned. No new key was created.

## Remaining limitations

- Complex comparisons can still fall back to Local mode if the model introduces
  a figure that a tool did not return. That fallback is intentional and safe.
- The probe is temporary and must be disabled and removed after the acceptance
  window.
- Staging remains synthetic-only. Production external AI remains disabled.
