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
| 1 | "Give me a summary of the business this month." | business tool + explanation |
| 2 | "What about last month?" | bounded follow-up context |

## Deployment

| Item | Value |
|---|---|
| Staging service | `bloomcore-one-staging` |
| Code SHA | `feb6367c0ad4ee4de1718b718aff227d90fc415f` |
| Deploy status | live |
| Environment | `APP_ENV=STAGING` |
| Provider control | `synthetic`, enabled, emergency stop off |
| Credential configured | true (boolean check only) |
| Model | `deepseek-flash` |

## Result — 4 November 2026, 18:59 UTC

| Turn | Mode | Provider | Model | Tool | Context used | Numeric integrity | Latency | Tokens |
|---|---|---|---|---|---|---|---|---|
| 1 | external | `deepseek-enhanced` | `deepseek-flash` | `business_summary` | false | verified | 10,270 ms | 5,457 in / 487 out |
| 2 | external | `deepseek-enhanced` | `deepseek-flash` | `period_comparison` | true | verified | 4,727 ms | 5,391 in / 486 out |

Provider audit rows (two):

```
provider:  deepseek
model:     deepseek-flash
purpose:   chat:business_summary
decision:  success
latency:   10270 ms
tokens:    5457 / 487

provider:  deepseek
model:     deepseek-flash
purpose:   chat:period_comparison
decision:  success
latency:   4727 ms
tokens:    5391 / 486
```

A scan of the audit ledger for prompt text found **0** rows containing message
content. The ledger stores decisions, categories, latency and token counts only.

## What this proves

- The request reached the fixed DeepSeek endpoint.
- Authentication succeeded with the existing rotated credential.
- The configured allow-listed model responded.
- The model selected an approved read-only tool.
- The server executed the tool against the staging database.
- The model explained the tool result.
- Every numeric token in both answers matched a tool result.
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
